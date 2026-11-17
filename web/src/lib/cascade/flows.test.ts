import {
  concat,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeFunctionData,
  getAddress,
  type Hex,
  HttpRequestError,
  maxUint256,
  recoverTypedDataAddress,
  serializeSignature,
  toFunctionSelector,
} from "viem";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import type { Deployment, ExpectedDeployment } from "./config";
import { CANCEL_COOLDOWN_S, FRONT_DOOR, FRONT_DOOR_V32, STAKER, STAKER_V32, VAULT_V32 } from "./abi";
import { scratchStore } from "./op-store";
import { checkWiring, type Wiring } from "./wiring";
import { PATH_TAO_TO_USDC, PRICE_CHECK_BPS, RESUME_WINDOW_MS, TOKENS, UNISWAP } from "./config";
import { STAKE_LAPSED } from "./trail";
import {
  assertRedeemListOpen,
  assertSiteAllows,
  assertWired,
  CANCEL_BEHIND,
  CANCEL_CHANGED,
  CANCEL_CHECK_MS,
  CANCEL_LEFT,
  CANCEL_MARGIN_S,
  CANCEL_OPEN_STATUS,
  CANCEL_REVERTED,
  CANCEL_REVERTED_LEFT,
  CANCEL_SENT_FROM_LATER,
  CANCEL_SENT_UNREAD,
  CANCEL_WAITING_STATUS,
  CANCEL_WONT_GO,
  cancelCall,
  CANCEL_CONFIRM_EVERY_MS,
  cancelConfirmed,
  cancelHoldS,
  cancelOutcomeNote,
  cancelWaitText,
  CLAIM_TAO_NOW,
  clearDeliveryCall,
  CLOSE_FIRST_NO_ROOM,
  CLOSE_FIRST_NO_USDC,
  CLOSE_FIRST_RECHECK,
  CLOSE_FIRST_STILL_FULL,
  CLOSE_FIRST_UNREAD,
  assertStakeFunded,
  closeFirst,
  needsWiring,
  RETIRED,
  USDC_OFF,
  claimCalls,
  claimRetryPatch,
  createFlowGuard,
  createSharedFlowGuard,
  depositTaoCalls,
  type FlowCall,
  isRevert,
  permitTypedData,
  freshStakeTerms,
  planResumeDeposit,
  planResumeStakeV3,
  planStakeV3,
  planCloseFirst,
  planCancelDeposit,
  planSendNow,
  planUnstake,
  PRICE_DISAGREES,
  receiveTaoCall,
  redeemDirectCall,
  refuseImpact,
  PRICE_UNCHECKED,
  pricesAgree,
  QuoteMovedError,
  quoteMoved,
  RESUME_UNQUOTED,
  SALE_DISAGREES,
  SALE_UNCHECKED,
  saleAgrees,
  saleFloor,
  SaleRefusedError,
  saleUsdcPerTao,
  spotUsdcPerTao,
  SEND_BATCH_CHANGED,
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
  SEND_WRONG_BATCH,
  STAKE_BELOW_FLOOR,
  sendNowCall,
  resumeStakeV3Calls,
  REDEEM_LIST_FULL,
  redeemCloseShort,
  revertArgs,
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
  whenWired,
  WIRING_MISMATCH,
  WIRING_UNCHECKED,
  wiringNotice,
} from "./flows";
import { IMPACT_REFUSED } from "./impact";
import { outsidePriceVeto, PRICE_OFF_MARKET, PRICE_UNCHECKABLE } from "./price-veto";
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

  it("waits for a wallet batch already sent whatever the record's mode: a batch rebuilt to be waited for is never sent one step at a time", async () => {
    const p = port({ canBatch: vi.fn(async () => false) });
    const t = tracker({}, { callsId: "batch-1", mode: "sequential" });
    await runFlow(p, t.store as never, calls);
    expect(p.waitBatch).toHaveBeenCalledWith("batch-1");
    expect(p.send).not.toHaveBeenCalled();
    expect(p.sendBatch).not.toHaveBeenCalled();
    expect(p.canBatch).not.toHaveBeenCalled();
    expect(t.states.at(-1)).toBe("sent");
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
    // and turning off USDC delivery for the account, which moves nothing (Task 60 review, Important 1)
    expect(needsWiring("delivery")).toBe(false);
  });

  it("holds any other flow, including one added later: only the ways out are named to skip the check", () => {
    for (const label of ["bridge", "restake", "", "Claim", "swap ", "Delivery", "delivery "]) expect(needsWiring(label), JSON.stringify(label)).toBe(true);
  });

  it("leaves open exactly the ways out, by the labels the app's flows run under", () => {
    const src = readFileSync(new URL("./use-flows.ts", import.meta.url), "utf8");
    const labels = [...new Set([...src.matchAll(/\bflow\("([^"]+)"/g)].map((m) => m[1]))];
    expect(labels).toEqual(expect.arrayContaining(["stake", "unstake", "claim", "cancel", "swap", "send", "delivery"]));
    // Send it now pays ETH into the front door: it waits for the contracts to check out
    expect(needsWiring("send")).toBe(true);
    expect(labels.filter((l) => !needsWiring(l)).sort()).toEqual(["cancel", "claim", "delivery", "swap"]);
    // the hook's one gate is whenWired, so what the tests below show of it is what the app's flows do
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    expect(code).toMatch(/guard\.run\(label, \(\) => whenWired\(label, \(\) => data\.checkWiring\(\), body\)\)/);
    expect(code).not.toContain("assertWired(");
  });

  it("leaves open only ways out that touch the listed front door and the fixed router, send no ETH, and approve only the router", () => {
    const fixed = new Set([D.frontDoor, TOKENS.tao, UNISWAP.router].map((a) => a.toLowerCase()));
    const exits: [string, FlowCall[]][] = [
      ["cancel a deposit", [cancelCall("deposit", 10n ** 16n, D)]],
      ["cancel an unstake", [cancelCall("withdrawal", 10n ** 21n, D)]],
      ["claim as USDC", claimCalls(10n ** 16n, 2_400_000n, none, D, ME, false)],
      ["claim as TAO", claimCalls(10n ** 16n, 0n, none, D, ME, true)],
      ["swap wallet TAO to USDC", sellTaoCalls(10n ** 16n, 2_400_000n, none, ME)],
      // v3.2's front door is D's (D32 is D with a staker, an oracle and lenses)
      ["turn off USDC delivery", [clearDeliveryCall(D32)]],
    ];
    expect(D32.frontDoor).toBe(D.frontDoor);
    for (const [name, calls] of exits) {
      for (const c of calls) {
        expect(fixed.has(c.to.toLowerCase()), `${name}: ${c.functionName} to ${c.to}`).toBe(true);
        expect(c.value ?? 0n, `${name}: ${c.functionName} value`).toBe(0n);
        if (c.functionName === "approve") expect((c.args[0] as string).toLowerCase(), name).toBe(UNISWAP.router.toLowerCase());
        if (c.functionName === "exactInput") expect((c.args[0] as { recipient: string }).recipient, name).toBe(ME);
      }
    }
  });

  it("turns off USDC delivery whatever the check says: a bridge disabled, the door removed, an RPC down (Task 60 review, Important 1)", async () => {
    // D32 as a committed v3.2 entry, so the check reads the chains (checkWiring refuses an unlisted one unread)
    const list: Record<string, ExpectedDeployment> = {
      "v3.2-x": {
        version: 3,
        stage: "early",
        usdcDelivery: false,
        frontDoor: D32.frontDoor,
        baseAdapter: D32.baseAdapter,
        vault: D32.vault,
        bitAdapter: D32.bitAdapter,
        staker: D32.staker,
        oracle: D32.oracle,
        vaultLens: D32.vaultLens,
        doorLens: D32.doorLens,
        bitBlock: String(D32.bitBlock),
        vaultSs58: D32.vaultSs58,
        hotkeySs58: D32.hotkeySs58,
      },
    };
    // what each chain's contracts answer, by `${chain}.${function}` (D's front door and vault share an address, as do its
    // two adapters): wired as built, unless `over` says otherwise; `down`, every read failing as an unreachable node's
    const wired: Record<string, unknown> = {
      "base.asset": TOKENS.tao,
      "base.vault": D32.vault,
      "base.vaultChain": 964n,
      "base.target": D32.frontDoor,
      "base.primaryBridge": D32.baseAdapter,
      "base.bridgeEnabled": true,
      "base.token": TOKENS.tao,
      "base.remoteAdapter": D32.bitAdapter,
      "base.remoteChainId": 964n,
      "base.usdc": TOKENS.usdc,
      "base.oracle": D32.oracle,
      "base.swapper": D32.staker,
      "base.frontDoor": D32.frontDoor,
      "base.tao": TOKENS.tao,
      "bittensor.target": D32.vault,
      "bittensor.doorState": 1,
      "bittensor.primaryBridge": D32.bitAdapter,
      "bittensor.bridgeEnabled": true,
      "bittensor.remoteAdapter": D32.baseAdapter,
      "bittensor.remoteChainId": 8453n,
    };
    const chains = (over: Record<string, unknown> = {}, down?: "base" | "bittensor") => {
      const client = (name: "base" | "bittensor") => ({
        async multicall({ contracts }: { contracts: { functionName: string }[] }) {
          return contracts.map((k) => {
            if (down === name) return { status: "failure", error: new HttpRequestError({ url: "https://archive.chain.opentensor.ai" }) };
            const id = `${name}.${k.functionName}`;
            return { status: "success", result: id in over ? over[id] : wired[id] };
          });
        },
      });
      return { base: client("base"), bittensor: client("bittensor") } as never;
    };
    // the fake is the contracts as built: the check passes
    expect(await checkWiring(chains(), D32, list)).toBe("ok");
    const failing: [string, () => Promise<Wiring>, string][] = [
      // a stolen owner or guardian key's disableBridge, on either chain, and removeFrontDoor (spec §5's stalemate)
      ["the vault's bridge disabled", () => checkWiring(chains({ "bittensor.bridgeEnabled": false }), D32, list), WIRING_MISMATCH],
      ["the front door's bridge disabled", () => checkWiring(chains({ "base.bridgeEnabled": false }), D32, list), WIRING_MISMATCH],
      ["the door removed", () => checkWiring(chains({ "bittensor.doorState": 2 }), D32, list), WIRING_MISMATCH],
      // an RPC that can't be read
      ["Bittensor's RPC down", () => checkWiring(chains({}, "bittensor"), D32, list), WIRING_UNCHECKED],
      ["Base's RPC down", () => checkWiring(chains({}, "base"), D32, list), WIRING_UNCHECKED],
    ];
    for (const [name, check, refusal] of failing) {
      // the turn-off: sent, exactly setDelivery(0, 0, 0) to the deployment's front door, no ETH, without even waiting
      // for the check
      const sends: FlowCall[] = [];
      const w = port({ send: async (c: FlowCall) => (sends.push(c), H(1)) });
      const asked = vi.fn(check);
      await whenWired("delivery", asked, () => runFlow(w, scratchStore(), [clearDeliveryCall(D32)]));
      expect(sends, name).toEqual([clearDeliveryCall(D32)]);
      expect(sends[0], name).toMatchObject({ to: D32.frontDoor, functionName: "setDelivery", args: [0n, 0n, 0] });
      expect(sends[0]?.value, name).toBeUndefined();
      expect(asked, name).not.toHaveBeenCalled();
      // an unstake under the same check: refused, nothing sent
      const u = port();
      const sent = vi.fn(async () => runFlow(u, scratchStore(), [receiveTaoCall(10n ** 21n, 0n, 10n ** 14n, D32)]));
      await expect(whenWired("unstake", check, sent), name).rejects.toThrow(refusal);
      expect(sent, name).not.toHaveBeenCalled();
      expect(u.send, name).not.toHaveBeenCalled();
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

describe("carrying on a v2 stake or a deposit of wallet TAO (planResumeDeposit)", () => {
  const TAO = 78_000_000_000_000_000n;
  const walletTao = { usdcIn: 0n, targetTao: TAO, hashes: {} as Partial<Record<string, Hex>>, createdAt: NOW - 60_000 };
  const v2 = { usdcIn: 20_000_000n, targetTao: TAO, hashes: {} as Partial<Record<string, Hex>>, createdAt: NOW - 60_000 };
  const today = { ...q3, targetTao: 77_800_000_000_000_000n, minTaoOut: 77_800_000_000_000_000n } as DepositQuote;
  const resume = (op: typeof v2, chain: { walletTao: bigint; depositOf: bigint }, over: Partial<Parameters<typeof planResumeDeposit>[0]> = {}) =>
    planResumeDeposit({ op, w: none, d: D, account: ME, now: NOW, chain, quote: async () => today, record: vi.fn(), ...over });

  it("sends nothing for a deposit of wallet TAO the chain shows already in the batch, though its hash was lost (a reload while the wallet sent it)", async () => {
    const quote = vi.fn(async () => today);
    expect(await resume(walletTao, { walletTao: 0n, depositOf: TAO }, { quote })).toEqual([]);
    expect(await resume(walletTao, { walletTao: 0n, depositOf: TAO + 1n }, { quote })).toEqual([]);
    expect(quote).not.toHaveBeenCalled();
  });

  it("deposits wallet TAO still in the wallet, an exact approval then the deposit, never quoting (there is no price to quote)", async () => {
    const quote = vi.fn(async () => today);
    const calls = await resume(walletTao, { walletTao: TAO, depositOf: 0n }, { quote });
    expect(calls.map((c) => c.key)).toEqual(["approveTao", "deposit"]);
    expect(calls[1].args).toEqual([TAO]);
    expect(quote).not.toHaveBeenCalled();
  });

  it("a v2 stake whose swap the chain shows done (the TAO is in the wallet) goes on from the deposit, at the TAO it bought, without a quote", async () => {
    const quote = vi.fn(async () => today);
    const record = vi.fn();
    const calls = await resume(v2, { walletTao: TAO, depositOf: 0n }, { quote, record });
    expect(calls.map((c) => c.key)).toEqual(["approveTao", "deposit"]);
    expect(quote).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    // or already deposited: nothing
    expect(await resume(v2, { walletTao: 0n, depositOf: TAO }, { quote })).toEqual([]);
  });

  it("a v2 stake whose swap was sent (its hash recorded) is only waited for, never quoted again", async () => {
    const quote = vi.fn(async () => today);
    const calls = await resume({ ...v2, hashes: { swap: H(1) } }, { walletTao: 0n, depositOf: 0n }, { quote });
    expect(calls.map((c) => c.key)).toEqual(["approveUsdc", "swap", "approveTao", "deposit"]);
    expect(calls[1].args).toEqual([expect.objectContaining({ amountOut: TAO })]);
    expect(quote).not.toHaveBeenCalled();
  });

  it("a v2 stake whose swap was never sent goes at today's terms, never the recorded ones", async () => {
    const record = vi.fn();
    const calls = await resume(v2, { walletTao: 0n, depositOf: 0n }, { record });
    expect(calls.map((c) => c.key)).toEqual(["approveUsdc", "swap", "approveTao", "deposit"]);
    expect(calls[1].args).toEqual([expect.objectContaining({ amountOut: today.targetTao, amountInMaximum: v2.usdcIn })]);
    expect(record).toHaveBeenCalledExactlyOnceWith({ targetTao: today.targetTao, minTaoOut: today.minTaoOut, priceUsd: today.taoPriceUsd, feesUsd: today.feesUsd });
    // and a day on, isn't carried on at all
    expect(((await resume({ ...v2, createdAt: NOW - RESUME_WINDOW_MS }, { walletTao: 0n, depositOf: 0n }).catch((e: unknown) => e)) as FlowError).message).toBe(STAKE_LAPSED);
  });
});

describe("the sale of TAO to USDC on the ways out (saleFloor)", () => {
  const TAO = 10n ** 17n;
  /** Selling 0.1 TAO pays $25.41: $254.10 a TAO, a touch under the oracle's $255 (pool fees, impact). */
  const OUT = 25_410_000n;
  const floor = (over: Partial<Parameters<typeof saleFloor>[0]> = {}) => saleFloor({ taoWei: TAO, quote: async () => OUT, oracle: ORACLE, ...over });

  it("prices a sale as the USDC it pays per TAO", () => {
    expect(saleUsdcPerTao({ taoWei: TAO, usdcOut: OUT })).toBe(254_100_000n);
    expect(saleUsdcPerTao({ taoWei: 0n, usdcOut: OUT })).toBe(0n);
  });

  it("gives the floor, 0.5% under today's quote, when the sale pays within 5% of the oracle, or more than the oracle", async () => {
    expect(await floor()).toBe((OUT * 9_950n) / 10_000n);
    // paying more than the oracle says is no reason to hold a sale
    expect(await floor({ quote: async () => 30_000_000n })).toBe((30_000_000n * 9_950n) / 10_000n);
    // 5% under exactly: still sold
    expect(await floor({ quote: async () => (255_000_000n * 9_500n) / 10_000n / 10n })).toBe((((255_000_000n * 9_500n) / 10_000n / 10n) * 9_950n) / 10_000n);
  });

  it("holds a sale that would pay more than 5% under the oracle, in words that offer the TAO instead, and sells nothing", async () => {
    const err = await floor({ quote: async () => 23_000_000n }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SaleRefusedError);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).state).toBe("needs-you");
    expect((err as FlowError).message).toBe(SALE_DISAGREES);
    expect(SALE_DISAGREES).toBe("The price we were quoted for selling your TAO is more than 5% under Cascade's price oracle, so it wasn't sold. Keep it as TAO for now, or try again in a few minutes.");
  });

  it("holds the sale when the oracle can't be read, saying so, and never on a quote of nothing", async () => {
    const err = await floor({ oracle: async () => Promise.reject(new Error("HTTP request failed. URL: https://base-rpc.publicnode.com")) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SaleRefusedError);
    expect((err as FlowError).message).toBe(SALE_UNCHECKED);
    expect((err as FlowError).message).not.toMatch(/publicnode/);
    expect(((await floor({ quote: async () => 0n }).catch((e: unknown) => e)) as FlowError).message).toBe(SALE_DISAGREES);
  });

  it("makes no check on a deployment without an oracle (v2): the floor is today's quote less 0.5%", async () => {
    expect(await floor({ oracle: undefined, quote: async () => 23_000_000n })).toBe((23_000_000n * 9_950n) / 10_000n);
  });

  it("agrees a sale within 5% under the oracle, any amount over it, and not beyond", () => {
    const oracle = 255_000_000n;
    expect(saleAgrees((oracle * 9_500n) / 10_000n, oracle)).toBe(true);
    expect(saleAgrees((oracle * 9_500n) / 10_000n - 1n, oracle)).toBe(false);
    expect(saleAgrees(oracle * 2n, oracle)).toBe(true);
    expect(saleAgrees(0n, oracle)).toBe(false);
    expect(saleAgrees(oracle, 0n)).toBe(false);
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

  it("a record dated after now (the clock put back since) is still searched for on the chain, and a stake found is only waited for: nothing is sent", async () => {
    const t = tracker();
    const quote = vi.fn(async () => today);
    const findStake = vi.fn(async () => H(62));
    const calls = await resume({ op: { ...op, createdAt: NOW + 2 * 60 * 60_000 }, findStake, adopt: (h) => t.store.setHash("stake", h), quote });
    expect(findStake).toHaveBeenCalledOnce();
    expect(calls.map((c) => c.key)).toEqual(["stake"]);
    expect(quote).not.toHaveBeenCalled();
    const p = port();
    await runFlow(p, t.store as never, calls);
    expect(p.send).not.toHaveBeenCalled();
    expect(p.sendBatch).not.toHaveBeenCalled();
    expect(p.wait).toHaveBeenCalledWith(H(62), expect.any(Function));
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


// ---- v3.2: Send it now by the batch's id, the staker's buy floor, and no opt-in direct redeem ----

/** A v3.2 deployment: a v3 one (staker and oracle) with its two lenses, on the launch's 24-hour cadence. */
const D32: Deployment = {
  ...D3,
  vaultLens: getAddress("0x000000000000000000000000000000000000Ae15"),
  doorLens: getAddress("0x000000000000000000000000000000000000De15"),
  batchMaxWaitS: 86_400,
};

describe("Send it now on v3.2: closeBatch(id, minValue), the id the user saw and their own deposit", () => {
  const START = 1_800_000_000;
  /** The open batch as read again at the click, as in "Send it now" above: batch 7, the account's 0.1 TAO in it. */
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
    closesWhilePaused: true,
    ...over,
  });
  const ok = () => vi.fn<(c: FlowCall) => Promise<Simulation>>(async () => ({ ok: true }));
  const plan = (batch: OpenBatch | (() => Promise<OpenBatch>), simulate = ok(), depositWei: bigint = 10n ** 17n) =>
    planSendNow({ d: D32, batchId: 7n, depositWei, read: typeof batch === "function" ? batch : async () => batch, simulate });
  const refused = async (p: Promise<unknown>) => {
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FlowError);
    return e as FlowError;
  };
  const reverting = (revert: string) => vi.fn(async (): Promise<Simulation> => ({ ok: false, revert }));

  it("sendNowPassesTheSeenIdAndTheUsersDeposit", async () => {
    const simulate = ok();
    const { call } = await plan(open(), simulate);
    expect(call).toEqual({ key: "close", to: D32.frontDoor, abi: FRONT_DOOR_V32, functionName: "closeBatch", args: [7n, 10n ** 17n], value: 969_000_000_000_000n });
    expect(call).toEqual(sendNowCall(969_000_000_000_000n, D32, { batchId: 7n, minValue: 10n ** 17n }));
    expect(simulate).toHaveBeenCalledExactlyOnceWith(call);
    // the calldata is v3.2's closeBatch(uint64 expectedId, uint256 minValue)
    const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never);
    expect(data.slice(0, 10)).toBe(toFunctionSelector("closeBatch(uint64,uint256)"));
    expect(decodeFunctionData({ abi: FRONT_DOOR_V32, data }).args).toEqual([7n, 10n ** 17n]);
    // the deposit the user saw, never one read since: a larger one read at the click still asks only for it
    expect((await plan(open({ mine: { depositWei: 3n * 10n ** 17n, redeemShares: 0n } }))).call.args).toEqual([7n, 10n ** 17n]);
    // an unstake alone asks for no minimum
    expect((await plan(open({ mine: { depositWei: 0n, redeemShares: 10n ** 21n } }), ok(), 0n)).call.args).toEqual([7n, 0n]);
    // v3-launch keeps its closeBatch(), whatever it is given
    expect(sendNowCall(10n ** 15n, D, { batchId: 7n, minValue: 1n })).toEqual({
      key: "close",
      to: D.frontDoor,
      abi: FRONT_DOOR,
      functionName: "closeBatch",
      args: [],
      value: 10n ** 15n,
    });
    // and a v3.2 close is never built without the batch the user saw
    expect(() => sendNowCall(10n ** 15n, D32)).toThrow(/batch/i);
    await expect(planSendNow({ d: D32, batchId: 7n, read: async () => open(), simulate: ok() })).rejects.toThrow(/deposit/i);
  });

  it("sendNowRevertCopy", async () => {
    // the batch left before the click: WrongBatch(openId), said in plain words, and nothing retried
    const wrong = reverting("WrongBatch");
    const left = await refused(plan(open(), wrong));
    expect(left.message).toBe(SEND_WRONG_BATCH);
    expect(SEND_WRONG_BATCH).toBe("Your batch has already been sent. There is nothing more to do.");
    expect(left.state).toBe("failed");
    expect(wrong).toHaveBeenCalledOnce();
    // a cancel lowered it under the deposit the user saw: BatchTooSmall
    const changed = await refused(plan(open(), reverting("BatchTooSmall")));
    expect(changed.message).toBe(SEND_BATCH_CHANGED);
    expect(SEND_BATCH_CHANGED).toBe("The batch changed since you looked. Check it and try again.");
    expect(changed.state).toBe("needs-you");
    // the read at the click already shows the next batch open: the same words, and no other batch is ever sent
    const read = vi.fn(async () => open({ id: 8n }));
    const simulate = ok();
    expect((await refused(plan(read, simulate))).message).toBe(SEND_WRONG_BATCH);
    expect(read).toHaveBeenCalledOnce();
    expect(simulate).not.toHaveBeenCalled();
    // Base names both errors from v3.2's front door, so neither shows as a raw revert
    const reverted = (errorName: "WrongBatch" | "BatchTooSmall", args?: readonly unknown[]) =>
      new ContractFunctionExecutionError(
        new ContractFunctionRevertedError({
          abi: FRONT_DOOR_V32,
          functionName: "closeBatch",
          data: encodeErrorResult({ abi: FRONT_DOOR_V32, errorName, args } as never),
        }),
        { abi: FRONT_DOOR_V32, functionName: "closeBatch", args: [] },
      );
    expect(revertReason(reverted("WrongBatch", [8n]))).toBe("WrongBatch");
    expect(revertReason(reverted("BatchTooSmall"))).toBe("BatchTooSmall");
    // v3-launch's words for a batch gone stay as they were
    const launch = await refused(planSendNow({ d: { ...D, batchMaxWaitS: 86_400 }, batchId: 7n, read: async () => open({ id: 8n }), simulate: ok() }));
    expect(launch.message).toBe(SEND_GONE);
  });

  it("sends the batch while the front door is paused: on v3.2 its pause stops only new stakes", async () => {
    const simulate = ok();
    expect((await plan(open({ paused: true }), simulate)).call.args).toEqual([7n, 10n ** 17n]);
    expect(simulate).toHaveBeenCalledOnce();
    // what does stop a close, a disabled bridge, is said as itself: Cascade may well not be paused (Task 58 review, Minor 4)
    expect((await refused(plan(open(), reverting("PrimaryBridgeDisabled")))).message).toBe("Sending batches is on hold right now, so nothing was sent.");
    // a batch that can't close after all (a cancel shortened its full list): not yet
    expect((await refused(plan(open(), reverting("BatchNotReady")))).message).toBe(SEND_NOT_YET);
    // v3-launch's paused front door still sends nothing
    const launch = planSendNow({ d: { ...D, batchMaxWaitS: 86_400 }, batchId: 7n, read: async () => open({ paused: true, closesWhilePaused: undefined }), simulate: ok() });
    expect((await refused(launch)).message).toBe(SEND_PAUSED);
  });
});

describe("R8 (the contracts review's L-1): send the full open batch first, then stake (planCloseFirst, closeFirst)", () => {
  const START = 1_800_000_000;
  /** R12c: the door's launch limits, read with the batch at the click (its deposit list, 1 of 50; 10 TAO a batch, a 0.04
   * TAO minimum, a 40 TAO cap, none of it forwarded yet) */
  const LIMITS = { nDeposits: 1, maxDeposits: 50, maxBatchValue: 10n ** 19n, minDeposit: 4n * 10n ** 16n, depositCap: 4n * 10n ** 19n, netForwarded: 0n };
  /** A holder's full batch, as the account reads it at the click: 10 TAO of deposits, none of the account's, closable */
  const full = (over: Partial<OpenBatch> = {}): OpenBatch => ({
    id: 7n,
    start: START,
    interval: 3_600,
    canClose: true,
    paused: false,
    chainTime: START + 120,
    mine: { depositWei: 0n, redeemShares: 0n },
    nRedeems: 0,
    maxRedeems: 50,
    potWei: 0n,
    totalWei: 10n ** 19n,
    limits: LIMITS,
    feeWei: 744_898_037_875_672n,
    ethWei: 10n ** 16n,
    gasWei: 10n ** 13n,
    ethPriceUsd: 2_330,
    bittensor: "open",
    closesWhilePaused: true,
    ...over,
  });
  /** R12c: a batch due by time alone: past its interval, 2 TAO of the 10 TAO limit, under every line */
  const due = (over: Partial<OpenBatch> = {}): OpenBatch => full({ chainTime: START + 3_700, totalWei: 2n * 10n ** 18n, ...over });
  /** R12e: a full batch's floor for the user's close, 10 of 10 TAO: no minimum deposit fits under the limit, so the limit
   * less a minimum, and a wei (the highest line that held; half the limit held too) */
  const AT_THE_LIMIT = 10n ** 19n - 4n * 10n ** 16n + 1n;
  const ok = () => vi.fn<(c: FlowCall) => Promise<Simulation>>(async () => ({ ok: true }));
  const reverting = (revert: string) => vi.fn(async (): Promise<Simulation> => ({ ok: false, revert }));
  /** R9 (L-1): the close is planned for the batch the form's note was priced from (7, unless `batchId`) */
  const plan = (b: OpenBatch | (() => Promise<OpenBatch>), simulate = ok(), batchId = 7n) =>
    planCloseFirst({ d: D32, batchId, read: typeof b === "function" ? b : async () => b, simulate });
  const refused = async (p: Promise<unknown>) => {
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FlowError);
    return e as FlowError;
  };

  it("closeBatch(the open id, its minValue as the click's read gives it: R12c), with Send it now's value (the fee plus 30%, less the pot), run from the account first", async () => {
    const simulate = ok();
    const p = await plan(full(), simulate);
    // R12c: full by its value (10 of 10 TAO), so a total still full; R12e: the highest line that held, for the user's paid
    // close: at the limit no minimum fits under it, so within a minimum of the limit (half the limit, the keeper's, is lower)
    expect(p.call).toEqual(sendNowCall(969_000_000_000_000n, D32, { batchId: 7n, minValue: AT_THE_LIMIT }));
    expect(p.call).toMatchObject({ functionName: "closeBatch", args: [7n, AT_THE_LIMIT], value: 969_000_000_000_000n, to: D32.frontDoor, abi: FRONT_DOOR_V32 });
    expect(simulate).toHaveBeenCalledExactlyOnceWith(p.call);
    // the batch read at the click, never the one the form saw: a holder's top-up is in a due batch's exact total
    expect((await plan(due({ totalWei: 3n * 10n ** 18n }))).call?.args).toEqual([7n, 3n * 10n ** 18n]);
    // the pot pays first: fee 0.001, pot 0.0004, so 0.0009 sent
    expect((await plan(full({ feeWei: 10n ** 15n, potWei: 4n * 10n ** 14n }))).call?.value).toBe(9n * 10n ** 14n);
    // v3-launch's closeBatch() names no batch: never planned there
    await expect(planCloseFirst({ d: D, batchId: 7n, read: async () => full(), simulate: ok() })).rejects.toThrow(/v3\.2/);
  });

  it("R9 (L-1): the open batch read at the click isn't the one the note was priced from: it has left, so no close is sent (\"left\") and the room is read again", async () => {
    const simulate = ok();
    // batch 7 left (the keeper's close, or anyone's) and batch 8 is the open one, full again: never closed in its place
    expect(await plan(full({ id: 8n }), simulate)).toMatchObject({ skip: "left", batch: { id: 8n } });
    expect(simulate).not.toHaveBeenCalled();
    // the note priced batch 8 and the click reads it: planned as before
    expect((await plan(full({ id: 8n }), ok(), 8n)).call?.args).toEqual([8n, AT_THE_LIMIT]);
  });

  /** R12c: the door's own check at the close: a holder cancels `cancel` wei from an aged entry first (a partial cancel moves
   * no clock), then closeBatch reverts BatchTooSmall below its minValue, and BatchNotReady once nothing lets it close
   * (`still`: canClose() after the cancel; by default it does) */
  const cancelFirst = (b: OpenBatch, cancel: bigint, still = true) =>
    vi.fn(async (c: FlowCall): Promise<Simulation> => {
      if (!still) return { ok: false, revert: "BatchNotReady" };
      return (b.totalWei as bigint) - cancel < (c.args?.[1] as bigint) ? { ok: false, revert: "BatchTooSmall" } : { ok: true };
    });
  const RAO = 10n ** 9n;
  const TAO = 10n ** 18n;

  it("R12c: an aged entry's 1-rao cancel between the click's read and the close no longer voids a full batch's close: it names a total still full (the keeper's lines; R12e: the highest that held), before or past its interval", async () => {
    // before its interval, full by value (10 of 10 TAO): the close goes with a rao cancelled first (the exact total it
    // named before, 10 TAO, made it revert BatchTooSmall, skipped as "changed", for a holder's few cents each time)
    const before = await plan(full(), cancelFirst(full(), RAO));
    expect(before.skip).toBeUndefined();
    expect(before.call?.args).toEqual([7n, AT_THE_LIMIT]);
    // past its interval too, never 0: a close that lands past it is canClose()'s by time, so the door no longer guards the
    // line, and a wallet prompt may sit for minutes, so a read before the interval may land after it
    const late = full({ chainTime: START + 3_700, totalWei: 6n * TAO });
    expect((await plan(late, cancelFirst(late, RAO))).call?.args).toEqual([7n, 5n * TAO]);
    expect((await plan(full({ chainTime: START + 3_590 }), ok())).call?.args).toEqual([7n, AT_THE_LIMIT]);
    // R12e: the highest of the limits that held: 9.8 TAO, half a 16 TAO limit (8) and half the cap's room left by 30 of 40 (5)
    const capped = full({ totalWei: 98n * 10n ** 17n, limits: { ...LIMITS, maxBatchValue: 16n * TAO, netForwarded: 30n * TAO } });
    expect((await plan(capped, ok())).call?.args).toEqual([7n, 8n * TAO]);
    // no room for a minimum deposit under half (a 6 TAO minimum): the limit less the minimum, and a wei
    const room = full({ totalWei: 45n * 10n ** 17n, limits: { ...LIMITS, minDeposit: 6n * TAO } });
    expect((await plan(room, ok())).call?.args).toEqual([7n, 4n * TAO + 1n]);
  });

  it("R12c, R12e: the worst case is the highest line that held: cancels that take the batch under any value limit that held at the read still revert the close (BatchTooSmall, or BatchNotReady before its interval), so the room is read again and nothing more is paid", async () => {
    // 10 TAO down to 4.99 TAO before the close: under half the limit, so the close the site names can't land
    const under = await plan(full(), cancelFirst(full(), 5n * TAO + 10n ** 16n));
    expect(under).toMatchObject({ skip: "changed" });
    expect(under.call).toBeUndefined();
    // R12e: down to its highest line, the limit less a minimum and a wei: still full by it, and the close goes
    expect((await plan(full(), cancelFirst(full(), 4n * 10n ** 16n - 1n))).call?.args).toEqual([7n, AT_THE_LIMIT]);
    // a minimum deposit's cancel: still at half the limit (the keeper's line), but under the higher line the user was shown
    // it full by: the user's close reverts BatchTooSmall, and the room is read again (one retry); before R12e it went
    expect(await plan(full(), cancelFirst(full(), 4n * 10n ** 16n))).toMatchObject({ skip: "changed" });
    // a batch at half alone (6 of 10 TAO): down to the line itself, 5 TAO, still full, and the close goes
    const half = full({ totalWei: 6n * TAO });
    expect((await plan(half, cancelFirst(half, TAO))).call?.args).toEqual([7n, 5n * TAO]);
    // before its interval the door refuses it as not ready once nothing makes it full
    expect(await plan(full(), cancelFirst(full(), 6n * TAO, false))).toMatchObject({ skip: "not-closable" });
  });

  it("R12d: full by its deposit list alone (25 of 50): the least the 25 entries the list needs can hold, 25 minimum deposits, so a rao's cancel leaves the close going; a full redeem list still names 0", async () => {
    const list = due({ limits: { ...LIMITS, nDeposits: 25 } });
    // 25 x 0.04 TAO, under the 2 TAO it holds
    expect((await plan(list, cancelFirst(list, RAO))).call?.args).toEqual([7n, TAO]);
    const redeems = due({ nRedeems: 50 });
    expect((await plan(redeems, cancelFirst(redeems, RAO))).call?.args).toEqual([7n, 0n]);
  });

  it("R12d: a mass cancel can't turn the user's paid close of a list-full batch into a tiny batch: below 25 minimum deposits the close reverts (BatchTooSmall), nothing more is paid, and the room is read again", async () => {
    const list = due({ limits: { ...LIMITS, nDeposits: 25 } });
    // 2 TAO down to 0.5 TAO before the close (whole entries cancelled): under the list's floor
    expect(await plan(list, cancelFirst(list, 15n * 10n ** 17n))).toMatchObject({ skip: "changed" });
    // down to the floor itself still goes
    expect((await plan(list, cancelFirst(list, TAO))).call?.args).toEqual([7n, TAO]);
  });

  it("R12c: a batch due by time alone keeps the exact total it read (the user pays for a batch that isn't full: any cancel first reverts the close, and the room is read again); so does a read without the door's limits", async () => {
    const d = due();
    expect((await plan(d, ok())).call?.args).toEqual([7n, 2n * TAO]);
    expect(await plan(d, cancelFirst(d, RAO))).toMatchObject({ skip: "changed" });
    // the limits not read with the batch: the exact total, as before R12c
    expect((await plan(full({ limits: undefined }), ok())).call?.args).toEqual([7n, 10n * TAO]);
    expect((await plan(full({ nRedeems: undefined, maxRedeems: undefined }), ok())).call?.args).toEqual([7n, 10n * TAO]);
  });

  it("a cancel that lands first (BatchTooSmall), another close first (WrongBatch), or a batch that can't close now: no close, and the stake goes on", async () => {
    expect(await plan(full(), reverting("BatchTooSmall"))).toMatchObject({ skip: "changed" });
    expect(await plan(full(), reverting("WrongBatch"))).toMatchObject({ skip: "left" });
    expect(await plan(full(), reverting("BatchNotReady"))).toMatchObject({ skip: "not-closable" });
    const simulate = ok();
    expect(await plan(full({ canClose: false }), simulate)).toMatchObject({ skip: "not-closable" });
    expect(simulate).not.toHaveBeenCalled();
  });

  it("refused, nothing sent: deposits paused, Bittensor's side not taking batches or unchecked, the fee unread or unconfirmed, ETH short, a disabled bridge, a fee that rose, a refund the wallet can't take", async () => {
    expect((await refused(plan(full({ paused: true })))).message).toBe("Staking is paused right now, so nothing was sent. Try again later.");
    expect((await refused(plan(full({ bittensor: "paused" })))).message).toBe(SEND_BLOCKED);
    expect((await refused(plan(full({ bittensor: "unchecked" })))).message).toBe(SEND_UNCHECKED);
    expect((await refused(plan(full({ feeWei: undefined })))).message).toBe(SEND_NO_FEE);
    expect((await refused(plan(full({ feeWei: undefined, feeUnconfirmed: true })))).message).toBe(SEND_FEE_UNCONFIRMED);
    expect((await refused(plan(full({ ethWei: 5n * 10n ** 14n })))).message).toBe("You need about $2.29 of ETH on Base for this.");
    expect((await refused(plan(full(), reverting("PrimaryBridgeDisabled")))).message).toBe("Sending batches is on hold right now, so nothing was sent.");
    expect((await refused(plan(full(), reverting("InsufficientFee")))).message).toBe(SEND_FEE_ROSE);
    expect((await refused(plan(full(), reverting("TransferFailed")))).message).toBe(SEND_NO_REFUND);
    expect((await refused(plan(full(), reverting("Mystery")))).message).toBe(SEND_NOT_NOW);
    expect((await refused(plan(async () => Promise.reject(new Error("down"))))).message).toBe(SEND_UNREAD);
  });

  type Room = "now" | "after-close" | "none";
  /** R10 (M-1): the limits as the click reads them: the batch the note priced (7), found closable by reads a refresh apart */
  const seenAt = (over: Partial<{ batchId: bigint; closableForMs: number }> = {}) => ({ afterClose: { maxTao: 10n ** 19n, maxUsd: 2_400, batchId: 7n, due: "full" as const, closableForMs: 30_000, ...over } });
  /** One read of the room at the click: what it makes of the stake, and the limits it read */
  const at = (room: Room, limits: ReturnType<typeof seenAt> | Record<string, never> = seenAt()) => ({ room, limits });

  it("closeFirst: a close that landed goes straight to the stake; one a cancel or another close beat (as planned, or reverted on chain) goes on once the room, read again, fits; else nothing of the stake is sent", async () => {
    const call = sendNowCall(1n, D32, { batchId: 7n, minValue: 1n });
    /** The room at the click ("after-close": the stake fits once the batch has left), then after the close (`after`) */
    const run = (p: Awaited<ReturnType<typeof planCloseFirst>>, sent: "landed" | "reverted" = "landed", after: Room = "now") => {
      const sendClose = vi.fn(async () => sent);
      const reads: Room[] = ["after-close", after];
      const room = vi.fn(async () => at(reads.shift() as Room));
      const planned = vi.fn(async () => p);
      return { sendClose, room, planned, done: closeFirst({ batchId: 7n, room, plan: planned, sendClose }) };
    };
    const landed = run({ call, batch: full() });
    expect(await landed.done).toBe("landed");
    expect(landed.sendClose).toHaveBeenCalledExactlyOnceWith(call, full());
    // read once, at the click, before the plan; not again after a close that landed
    expect(landed.room).toHaveBeenCalledOnce();
    // reverted on chain (a cancel landed in the same block: BatchTooSmall): room has opened, and the stake goes on
    const beaten = run({ call, batch: full() }, "reverted");
    expect(await beaten.done).toBe("reverted");
    expect(beaten.room).toHaveBeenCalledTimes(2);
    const skipped = run({ skip: "changed", batch: full() });
    expect(await skipped.done).toBe("changed");
    expect(skipped.sendClose).not.toHaveBeenCalled();
    // the batch filled again meanwhile: nothing of the stake is sent
    expect((await refused(run({ skip: "left", batch: full() }, "landed", "after-close").done)).message).toBe(CLOSE_FIRST_STILL_FULL);
    expect((await refused(run({ call, batch: full() }, "reverted", "none").done)).message).toBe(CLOSE_FIRST_STILL_FULL);
    expect(CLOSE_FIRST_STILL_FULL).toBe("The current batch is still full, so your stake wasn't sent. Try again in a minute.");
    // a close declined in the wallet, or not confirmed: its own stop, nothing more
    const declined = closeFirst({
      batchId: 7n,
      room: async () => at("after-close"),
      plan: async () => ({ call, batch: full() }),
      sendClose: async () => Promise.reject(new FlowError("You declined in your wallet, so nothing was sent.", "needs-you")),
    });
    expect((await refused(declined)).message).toBe("You declined in your wallet, so nothing was sent.");
  });

  it("R9 (L-1): the room read at the click first: a stake that fits the open batch now goes without any close; one that wouldn't fit even once the batch has left is refused before the close; a room that can't be read sends nothing", async () => {
    const call = sendNowCall(1n, D32, { batchId: 7n, minValue: 1n });
    const planned = vi.fn(async () => ({ call, batch: full() }));
    const sendClose = vi.fn(async () => "landed" as const);
    // the batch left (or a cancel made room) since the form's read: the stake goes straight in, nothing planned or sent
    expect(await closeFirst({ batchId: 7n, room: async () => at("now"), plan: planned, sendClose })).toBe("fits");
    // the cap filled, or the next batch's room shrank, meanwhile: paying for the close would only strand the stake
    expect((await refused(closeFirst({ batchId: 7n, room: async () => at("none"), plan: planned, sendClose }))).message).toBe(CLOSE_FIRST_NO_ROOM);
    expect(CLOSE_FIRST_NO_ROOM).toBe("The room for your stake changed since you looked, so nothing was sent. Check the amount and try again.");
    const unread = await refused(closeFirst({ batchId: 7n, room: async () => Promise.reject(new Error("down")), plan: planned, sendClose }));
    expect([unread.message, unread.state]).toEqual([CLOSE_FIRST_UNREAD, "needs-you"]);
    expect(planned).not.toHaveBeenCalled();
    expect(sendClose).not.toHaveBeenCalled();
  });

  it("R10 (M-1): the clock is the click's own read of the limits, never the form's cached one: a paid close only for the batch priced, found closable for CLOSE_FIRST_SEEN_MS (25 s); otherwise nothing is planned or sent, and it is checking again", async () => {
    const call = sendNowCall(1n, D32, { batchId: 7n, minValue: 1n });
    const planned = vi.fn(async () => ({ call, batch: full() }));
    const sendClose = vi.fn(async () => "landed" as const);
    const click = (limits: ReturnType<typeof seenAt> | Record<string, never>) => closeFirst({ batchId: 7n, room: async () => at("after-close", limits), plan: planned, sendClose });
    // the form showed the offer from a reading an hour old (a hidden tab), but the click's read finds the batch only just
    // closable again, half full now (the keeper would send it free), or another batch: no close is paid for
    for (const limits of [seenAt({ closableForMs: 0 }), seenAt({ closableForMs: 24_999 }), seenAt({ batchId: 8n }), {}]) {
      const e = await refused(click(limits));
      expect([e.message, e.state]).toEqual([CLOSE_FIRST_RECHECK, "needs-you"]);
    }
    expect(planned).not.toHaveBeenCalled();
    expect(sendClose).not.toHaveBeenCalled();
    expect(CLOSE_FIRST_RECHECK).toBe("We're checking the batch again, so nothing was sent. Try again in a moment.");
    // 25 s exactly, of the batch priced: planned and sent
    expect(await click(seenAt({ closableForMs: 25_000 }))).toBe("landed");
    expect(sendClose).toHaveBeenCalledOnce();
  });

  it("R9 (M-1): a stake the wallet's USDC can't pay is refused before the close is paid for (the stake's own run from the account can't go first: the full batch refuses it)", () => {
    const w = { usdc: 1_500_000_000n } as Balances;
    expect(() => assertStakeFunded({ usdcIn: 1_500_000_000n }, w)).not.toThrow();
    const e = (() => {
      try {
        assertStakeFunded({ usdcIn: 1_500_000_001n }, w);
      } catch (x) {
        return x as FlowError;
      }
    })();
    expect(e).toBeInstanceOf(FlowError);
    expect([e?.message, e?.state]).toEqual([CLOSE_FIRST_NO_USDC, "needs-you"]);
    expect(CLOSE_FIRST_NO_USDC).toBe("Your wallet doesn't hold the USDC for this stake now, so nothing was sent.");
  });
});

describe("a v3.2 stake refused by the staker's buy floor", () => {
  const permit = { deadline: DEADLINE, v: 27, r: H(1), s: H(2) };
  /** The stake reverts with `revert` in the pre-send check; USDC takes the permit. */
  const refusing = (revert: string) =>
    port({ simulate: vi.fn(async (c: FlowCall) => (c.functionName === "permit" ? { ok: true as const } : { ok: false as const, revert })) });

  it("stakeRefusedByTheFloorCopy", async () => {
    expect(STAKE_BELOW_FLOOR).toBe(
      "The price moved more than 5% from the market's average, so this stake was not sent. Nothing was spent; try again in a few minutes.",
    );
    // the pre-send check names the staker's BelowOracleFloor, so the stake stops before anything is sent
    const p = refusing("BelowOracleFloor");
    const err = await planStakeV3(p, { q: q3, w: none, d: D32, account: ME, nonce: async () => 7n, now: NOW, oracle: ORACLE }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).message).toBe(STAKE_BELOW_FLOOR);
    expect((err as FlowError).state).toBe("failed");
    expect(p.send).not.toHaveBeenCalled();
    expect(p.sendBatch).not.toHaveBeenCalled();
    // a front door with no oracle to price it by: staking is paused
    const noOracle = await planStakeV3(refusing("NoOracle"), { q: q3, w: none, d: D32, account: ME, nonce: async () => 7n, now: NOW, oracle: ORACLE }).catch(
      (e: unknown) => e,
    );
    expect((noOracle as FlowError).message).toBe("Staking is paused right now, so nothing was sent. Try again later.");
    // a v3.2 stake is built with the v3.2 staker's errors, so Base can name them; v3-launch's keeps its own ABI
    const [stake] = stakeV3Calls(q3, none, D32, ME, permit);
    expect(stake.abi).toBe(STAKER_V32);
    expect(stakeV3Calls(q3, none, D3, ME, permit)[0].abi).toBe(STAKER);
    for (const errorName of ["BelowOracleFloor", "NoOracle"] as const) {
      const e = new ContractFunctionExecutionError(
        new ContractFunctionRevertedError({ abi: STAKER_V32, functionName: "stakeWithPermit", data: encodeErrorResult({ abi: STAKER_V32, errorName }) }),
        { abi: STAKER_V32, functionName: "stakeWithPermit", args: [] },
      );
      expect(revertReason(e)).toBe(errorName);
    }
  });
});

describe("the direct redeem on Bittensor", () => {
  /** Every source file under web/src the site is built from (tests and fixtures left out). */
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const path = join(dir, f);
      if (statSync(path).isDirectory()) return f === "__fixtures__" ? [] : sources(path);
      return /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) ? [path] : [];
    });
  /** A source without its comments: what runs. */
  const code = (path: string) => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");

  it("neverOffersTheOptInDirectRedeem", () => {
    // the one direct redeem the site can build never accepts a loss to missing stake for the user
    expect(redeemDirectCall(10n ** 22n, D32)).toEqual({ key: "redeemDirect", to: D32.vault, abi: VAULT_V32, functionName: "redeemDirect", args: [10n ** 22n, false] });
    expect(() => redeemDirectCall(10n ** 22n, D3)).toThrow(/v3\.2/);
    // no other code of the site calls redeemDirect, so the opt-in has no other way in: the emergency page on Bittensor
    // (Task 59b, direct-exit.ts) sends only this call
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const callers = sources(root).filter((f) => code(f).includes("redeemDirect"));
    expect(callers.map((f) => f.slice(root.length).replace(/\\/g, "/")).sort()).toEqual(["lib/cascade/abi.ts", "lib/cascade/direct-exit.ts", "lib/cascade/flows.ts"]);
    expect(code(join(root, "lib/cascade/flows.ts")).match(/"redeemDirect", \[[^\]]*\]/g)).toEqual(['"redeemDirect", [shares, false]']);
    expect(code(join(root, "lib/cascade/direct-exit.ts")).match(/redeemDirect\w*/g)).toEqual(["redeemDirectCall", "redeemDirectCall"]);
    // an unstake from the site is the front door's request on Base, on v3.2 as before
    const q = { minUsdcPerTao: 123_456n, deliveryDeadline: 1_800_000_000 } as WithdrawalQuote;
    expect(unstakeV3Call(10n ** 22n, 0n, 10n ** 14n, q, D32)).toMatchObject({ to: D32.frontDoor, functionName: "requestRedeemWithDelivery" });
  });
});

describe("the site's 5% price check against v3.2's buy floor (T33's carry)", () => {
  it("is tighter than the staker's floor: any quote it lets through expects at least 95% of the oracle's TAO for the USDC swapped", () => {
    const oracle = 255_000_000n; // USDC units per TAO
    const swapped = 19_920_075n; // $20 less Cascade's fees
    // the most a TAO may cost in the quote and still pass: 5% over the oracle
    const edge = (oracle * (10_000n + PRICE_CHECK_BPS)) / 10_000n;
    const expectedTao = (swapped * 10n ** 18n) / edge;
    const q = { usdcIn: 20_000_000n, expectedTao, depositFeeUsdc: 50_000n, swapFeeUsdc: 29_925n };
    expect(pricesAgree(spotUsdcPerTao(q), oracle)).toBe(true);
    // the staker's floor: 95% of what the oracle gives for the USDC swapped (CascadeStaker, MAX_BUY_SLIPPAGE_BPS)
    const floor = (((swapped * 10n ** 18n) / oracle) * 9_500n) / 10_000n;
    expect(expectedTao > floor).toBe(true);
    // with room: 1/1.05 is 95.24% of the oracle's TAO
    expect((expectedTao * 10_000n) / ((swapped * 10n ** 18n) / oracle)).toBe(9_523n);
    // a quote just past the edge is refused by the site before the floor could refuse it on chain
    expect(pricesAgree(spotUsdcPerTao({ ...q, expectedTao: expectedTao - 10n ** 12n }), oracle)).toBe(false);
  });
});

// ---- v3.2: the outside-price veto in the stake flows (Task 58b; price-veto.ts holds its own rules) ----

describe("v3.2's outside-price veto in the stake flows", () => {
  /** The veto refusing, as price-veto.ts refuses: a FlowError, "needs you". */
  const refusing = () => vi.fn(async () => Promise.reject(new FlowError(PRICE_OFF_MARKET, "needs-you")));
  const passing = () => vi.fn(async () => undefined);
  const plan = (p: ReturnType<typeof port>, veto?: () => Promise<void>, w: Balances = none) =>
    planStakeV3(p, { q: q3, w, d: D32, account: ME, nonce: async () => 7n, now: NOW, oracle: ORACLE, ...(veto ? { veto } : {}) });

  it("a refused stake stops after the oracle's check and before the wallet is asked anything, in its words", async () => {
    const p = port();
    const oracle = vi.fn(ORACLE);
    const veto = refusing();
    const err = await planStakeV3(p, { q: q3, w: none, d: D32, account: ME, nonce: async () => 7n, now: NOW, oracle, veto }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).message).toBe(PRICE_OFF_MARKET);
    expect((err as FlowError).state).toBe("needs-you");
    expect(veto).toHaveBeenCalledOnce();
    expect(oracle.mock.invocationCallOrder[0]).toBeLessThan(veto.mock.invocationCallOrder[0]);
    expect(p.switchToBase).not.toHaveBeenCalled();
    expect(p.hasCode).not.toHaveBeenCalled();
    expect(p.signPermit).not.toHaveBeenCalled();
    expect(p.simulate).not.toHaveBeenCalled();
    // the reference can't be read: the same stop, its own words
    const unchecked = await plan(port(), vi.fn(async () => Promise.reject(new FlowError(PRICE_UNCHECKABLE, "needs-you")))).catch((e: unknown) => e);
    expect((unchecked as FlowError).message).toBe(PRICE_UNCHECKABLE);
  });

  it("a quote off the oracle is refused by the oracle's check first: the veto isn't asked", async () => {
    const veto = passing();
    const err = await planStakeV3(port(), { q: q3, w: none, d: D32, account: ME, nonce: async () => 7n, now: NOW, oracle: async () => 200_000_000n, veto }).catch((e: unknown) => e);
    expect((err as FlowError).message).toBe(PRICE_DISAGREES);
    expect(veto).not.toHaveBeenCalled();
  });

  it("a veto that lets the stake go changes nothing: the same calls, permit and floor as with none, by permit or by approval", async () => {
    for (const over of [{}, { hasCode: vi.fn(async () => true) }, { simulate: vi.fn(async () => ({ ok: false })) }]) {
      const withVeto = port(over);
      const without = port(over);
      const a = await plan(withVeto, passing());
      const b = await plan(without);
      expect(a).toEqual(b);
      expect(vi.mocked(withVeto.signPermit).mock.calls).toEqual(vi.mocked(without.signPermit).mock.calls);
      expect(a.find((c) => c.key === "stake")?.args.slice(0, 5)).toEqual([ME, q3.usdcIn, q3.minTaoOut, 0, DEADLINE]);
    }
    // an allowance that already covers it: no signature either way
    const covered = { ...none, usdcStakerAllowance: q3.usdcIn };
    expect(await plan(port(), passing(), covered)).toEqual(await plan(port(), undefined, covered));
  });

  describe("carrying on a stake (planResumeStakeV3)", () => {
    const op = { usdcIn: q3.usdcIn, targetTao: q3.targetTao, minTaoOut: q3.minTaoOut, hashes: {} as Partial<Record<string, Hex>>, callsId: undefined as string | undefined, createdAt: NOW - 60_000 };
    const today = { ...q3, targetTao: 77_800_000_000_000_000n, minTaoOut: 77_411_000_000_000_000n, taoPriceUsd: 257.07 } as DepositQuote;
    const resume = (over: Partial<Parameters<typeof planResumeStakeV3>[0]> = {}) =>
      planResumeStakeV3({ op, w: none, d: D32, account: ME, now: NOW, findStake: async () => null, adopt: vi.fn(), quote: async () => today, oracle: ORACLE, record: vi.fn(), ...over });

    it("checks today's terms after the oracle's check; refused, nothing is recorded or sent", async () => {
      const record = vi.fn();
      const oracle = vi.fn(ORACLE);
      const veto = refusing();
      const err = await resume({ record, oracle, veto }).catch((e: unknown) => e);
      expect((err as FlowError).message).toBe(PRICE_OFF_MARKET);
      expect((err as FlowError).state).toBe("needs-you");
      expect(record).not.toHaveBeenCalled();
      expect(oracle.mock.invocationCallOrder[0]).toBeLessThan(veto.mock.invocationCallOrder[0]);
    });

    it("a veto that lets it go changes nothing: the same calls at today's floor, the same terms recorded", async () => {
      const withVeto = vi.fn();
      const without = vi.fn();
      const a = await resume({ record: withVeto, veto: passing() });
      const b = await resume({ record: without });
      expect(a).toEqual(b);
      expect(a[1].args).toEqual([ME, q3.usdcIn, today.minTaoOut, 0, DEADLINE]);
      expect(withVeto.mock.calls).toEqual(without.mock.calls);
    });

    it("a stake already sent, or found on the chain, is only waited for: nothing to check", async () => {
      const veto = passing();
      expect((await resume({ op: { ...op, hashes: { stake: H(5) } }, veto })).map((c) => c.key)).toEqual(["stake"]);
      await resume({ op: { ...op, callsId: "batch-1" }, veto });
      await resume({ findStake: async () => H(61), veto });
      expect(veto).not.toHaveBeenCalled();
    });

    it("a quote that moved asks the user first, before any check", async () => {
      const veto = passing();
      const moved = await resume({ quote: async () => ({ ...today, targetTao: q3.targetTao / 2n }), veto }).catch((e: unknown) => e);
      expect(moved).toBeInstanceOf(QuoteMovedError);
      expect(veto).not.toHaveBeenCalled();
    });
  });

  it("v3-launch's stakes are planned as before: no veto is given them, and the plans ask for none", async () => {
    // the plans' veto is optional, and the site gives one only on v3.2 (price-veto.ts outsidePriceVeto)
    const p = port();
    const calls = await planStakeV3(p, { q: q3, w: none, d: D3, account: ME, nonce: async () => 7n, now: NOW, oracle: ORACLE });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ functionName: "stakeWithPermit", args: [ME, q3.usdcIn, q3.minTaoOut, 0, DEADLINE, DEADLINE, 28, H(201), H(202)] });
    expect(outsidePriceVeto(D3, { reference: async () => null, quoteBuy: async () => 0n, quoteSell: async () => 0n, nowMs: async () => NOW })).toBeUndefined();
  });
});

// ---- v3.2: receiving TAO, and the price-impact cap in the stake plans (Task 59a) ----

describe("v3.2's Receive TAO: an unstake with no delivery, claimed on Base by hand", () => {
  it("is the request with the account's USDC delivery preference cleared (a zero floor), under the same fee rule", () => {
    expect(receiveTaoCall(10n ** 22n, 0n, 10n ** 14n, D32)).toEqual({
      key: "request",
      to: D32.frontDoor,
      abi: FRONT_DOOR_V32,
      functionName: "requestRedeemWithDelivery",
      args: [10n ** 22n, 0n, 0n, 0],
      value: 10n ** 14n,
    });
    // a second request in the same batch pays no fee
    expect(receiveTaoCall(10n ** 22n, 5n, 10n ** 14n, D32).value).toBe(0n);
    // the front door clears a preference on a zero floor and checks nothing else of it (CascadeFrontDoor._setDelivery)
    const door = readFileSync(fileURLToPath(new URL("../../../../contracts/src/CascadeFrontDoor.sol", import.meta.url)), "utf8");
    expect(door).toMatch(/function _setDelivery\(uint128 minUsdcPerTao, uint64 deadline, uint32 destination\) internal \{\s*if \(minUsdcPerTao == 0\) \{\s*delete deliveryOf\[msg\.sender\];/);
  });

  it("is v3.2's alone: v3-launch's site never offers it", () => {
    expect(() => receiveTaoCall(10n ** 22n, 0n, 10n ** 14n, D3)).toThrow(/v3\.2/);
  });

  it("is planned with no price, quote, veto, limit or indexer: only the front door's fee read and the nonce, as any request", async () => {
    const order: string[] = [];
    const recorded: unknown[] = [];
    const calls = await planUnstake({
      q: { shares: 10n ** 22n, minUsdcPerTao: 0n, deliveryDeadline: 0 },
      d: D32,
      v3: true,
      keepTao: true,
      frontDoor: async () => (order.push("frontDoor"), { redeemOf: 0n, redeemRequestFee: 10n ** 14n }),
      accountCode: async () => (order.push("code"), undefined),
      pendingNonce: async () => (order.push("nonce"), 41),
      record: (patch) => void recorded.push(patch),
    });
    expect(calls).toEqual([receiveTaoCall(10n ** 22n, 0n, 10n ** 14n, D32)]);
    expect(order).toEqual(["frontDoor", "code", "nonce"]);
    expect(recorded).toEqual([{ fee: 10n ** 14n, nonce: 41 }]);
  });

  it("leaves the USDC request exactly as it was", async () => {
    const q = { shares: 10n ** 22n, minUsdcPerTao: 123_456n, deliveryDeadline: 1_800_000_000 } as WithdrawalQuote;
    const plan = (keepTao?: boolean) =>
      planUnstake({
        q,
        d: D32,
        v3: true,
        ...(keepTao !== undefined ? { keepTao } : {}),
        frontDoor: async () => ({ redeemOf: 0n, redeemRequestFee: 10n ** 14n }),
        accountCode: async () => undefined,
        pendingNonce: async () => 41,
        record: () => undefined,
      });
    expect(await plan(false)).toEqual(await plan());
    expect(await plan()).toEqual([unstakeV3Call(q.shares, 0n, 10n ** 14n, q, D32)]);
  });
});

describe("v3.2's price-impact cap in the stake plans", () => {
  /** q3 with a measured impact: `rate` of the $100 probe's TAO per USDC, in 1e6ths. */
  const withImpact = (rate: bigint) =>
    ({ ...q3, impact: { tradeIn: 1_000_000n, tradeOut: rate, probeIn: 1_000_000n, probeOut: 1_000_000n } }) as DepositQuote;

  it("refuses a fresh quote that moves the price by more than 3% before anything is asked, in the controller's words", () => {
    expect(() => refuseImpact(withImpact(969_900n))).toThrow(IMPACT_REFUSED);
    const err = (() => {
      try {
        refuseImpact(withImpact(969_900n));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(FlowError);
    expect((err as FlowError).state).toBe("needs-you");
    expect(refuseImpact(withImpact(970_000n))).toBeUndefined();
    expect(refuseImpact(q3)).toBeUndefined();
  });

  it("carrying on a v3.2 stake: today's quote over the cap is refused, nothing recorded; under it, the same as with none", async () => {
    const op = { usdcIn: q3.usdcIn, targetTao: q3.targetTao, minTaoOut: q3.minTaoOut, hashes: {} as Partial<Record<string, Hex>>, callsId: undefined as string | undefined, createdAt: NOW - 60_000 };
    const resume = (today: DepositQuote, record = vi.fn()) =>
      planResumeStakeV3({ op, w: none, d: D32, account: ME, now: NOW, findStake: async () => null, adopt: vi.fn(), quote: async () => today, oracle: ORACLE, record });
    const record = vi.fn();
    const err = await resume(withImpact(969_900n), record).catch((e: unknown) => e);
    expect((err as FlowError).message).toBe(IMPACT_REFUSED);
    expect(record).not.toHaveBeenCalled();
    const a = vi.fn();
    const b = vi.fn();
    expect(await resume(withImpact(970_000n), a)).toEqual(await resume(q3, b));
    expect(a.mock.calls).toEqual(b.mock.calls);
  });

  it("a quote's impact never reaches what is sent: a stake planned from it is the stake planned without it", async () => {
    for (const over of [{}, { hasCode: vi.fn(async () => true) }]) {
      const withIt = await planStakeV3(port(over), { q: withImpact(985_000n), w: none, d: D32, account: ME, nonce: async () => 7n, now: NOW, oracle: ORACLE });
      const without = await planStakeV3(port(over), { q: q3, w: none, d: D32, account: ME, nonce: async () => 7n, now: NOW, oracle: ORACLE });
      expect(withIt).toEqual(without);
    }
  });
});

// ---- Task 60: the founder's two switches (deployments.json: a deployment's stage, and v3.2's usdcDelivery) ----

describe("usdcDeliveryOffHidesTheOptionAndPromptsAClaim: the flows with USDC delivery off (spec §5)", () => {
  const off = { stage: "early" as const, usdcDelivery: false };
  const on = { stage: "early" as const, usdcDelivery: true };
  const stop = (f: () => void) => {
    try {
      f();
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it("refuses every way to USDC before anything is recorded or sent: the USDC unstake, a claim sold as USDC, a swap of wallet TAO", () => {
    const e = stop(() => assertSiteAllows("usdc", off));
    expect(e).toBeInstanceOf(FlowError);
    expect((e as FlowError).message).toBe(USDC_OFF);
    expect(USDC_OFF).toBe("USDC delivery is off, so nothing was sent.");
    // the ways out that need no USDC stay open: Receive TAO, the claim as TAO, a cancel
    expect(stop(() => assertSiteAllows("tao", off))).toBeUndefined();
    // with USDC delivery on, nothing is held
    expect(stop(() => assertSiteAllows("usdc", on))).toBeUndefined();
  });

  it("prompts a claim in the plan's words, and the claim it offers is the front door's claim() alone, which clears the preference", () => {
    expect(CLAIM_TAO_NOW).toBe("Claim your TAO now: USDC delivery is off.");
    // the claim kept as TAO: one call, claim(), nothing sold
    expect(claimCalls(10n ** 16n, 0n, none, D32, ME, true)).toEqual([{ key: "claim", to: D32.frontDoor, abi: FRONT_DOOR_V32, functionName: "claim", args: [] }]);
    // claim() clears the account's delivery preference as it pays (CascadeFrontDoor.claim; spec §5)
    const door = readFileSync(fileURLToPath(new URL("../../../../contracts/src/CascadeFrontDoor.sol", import.meta.url)), "utf8");
    expect(door).toMatch(/function claim\(\) external nonReentrant \{[^}]*?if \(deliveryOf\[msg\.sender\]\.minUsdcPerTao != 0\) \{\s*delete deliveryOf\[msg\.sender\];/);
    // and Receive TAO, still open, clears it too (a zero floor)
    expect(receiveTaoCall(10n ** 22n, 0n, 10n ** 14n, D32).args).toEqual([10n ** 22n, 0n, 0n, 0]);
  });
});

describe("retiredStageShowsOnlyExits: the flows on a retired deployment", () => {
  const retired = { stage: "retired" as const, usdcDelivery: true };
  const START = 1_800_000_000;
  const open = (mine: OpenBatch["mine"]): OpenBatch => ({
    id: 7n,
    start: START,
    interval: 3_600,
    canClose: true,
    paused: false,
    chainTime: START + 7_200,
    mine,
    potWei: 0n,
    feeWei: 744_898_037_875_672n,
    ethWei: 10n ** 16n,
    gasWei: 10n ** 13n,
    ethPriceUsd: 2_330,
    bittensor: "open",
    closesWhilePaused: true,
  });
  const ok = async (): Promise<Simulation> => ({ ok: true });

  it("refuses a stake (new, carried on, or of wallet TAO) in the plan's words", () => {
    let e: unknown;
    try {
      assertSiteAllows("stake", retired);
    } catch (x) {
      e = x;
    }
    expect(e).toBeInstanceOf(FlowError);
    expect((e as FlowError).message).toBe(RETIRED);
    expect(RETIRED).toBe("This version of Cascade is retired. Withdraw and claim here.");
    // every way out stays open: an unstake (USDC where delivery is on, or TAO), a claim
    for (const what of ["usdc", "tao"] as const) expect(() => assertSiteAllows(what, retired)).not.toThrow();
    // and nothing is held on a deployment that isn't retired
    for (const stage of ["testing", "early", "live"] as const) expect(() => assertSiteAllows("stake", { stage, usdcDelivery: true })).not.toThrow();
  });

  it("never sends a batch that holds the account's deposit, and still sends one that holds its unstake alone", async () => {
    const deposit = open({ depositWei: 10n ** 17n, redeemShares: 0n });
    for (const d of [D32, { ...D, batchMaxWaitS: 86_400 }]) {
      const e = await planSendNow({ d, batchId: 7n, depositWei: 10n ** 17n, read: async () => deposit, simulate: ok, retired: true }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(FlowError);
      expect((e as FlowError).message).toBe(RETIRED);
      // a deposit and an unstake together: still the deposit's batch
      const both = await planSendNow({ d, batchId: 7n, depositWei: 10n ** 17n, read: async () => open({ depositWei: 10n ** 17n, redeemShares: 10n ** 21n }), simulate: ok, retired: true }).catch((x: unknown) => x);
      expect((both as FlowError).message).toBe(RETIRED);
    }
    const unstake = await planSendNow({ d: D32, batchId: 7n, depositWei: 0n, read: async () => open({ depositWei: 0n, redeemShares: 10n ** 21n }), simulate: ok, retired: true });
    expect(unstake.call.args).toEqual([7n, 0n]);
    // not retired: a deposit's batch goes as before
    await expect(planSendNow({ d: D32, batchId: 7n, depositWei: 10n ** 17n, read: async () => deposit, simulate: ok })).resolves.toBeDefined();
  });
});

describe("where the site asks the switches (use-flows.ts; Task 60)", () => {
  /** use-flows.ts without its comments: what runs. */
  const code = readFileSync(fileURLToPath(new URL("./use-flows.ts", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  /** One entry of the object useFlows returns, up to the next one. */
  const block = (name: string) => {
    const start = code.indexOf(`\n    ${name}: (`);
    expect(start, name).toBeGreaterThan(0);
    const next = /\n {4}[A-Za-z]+(: \(|\()/g;
    next.lastIndex = start + 1;
    return code.slice(start, next.exec(code)?.index ?? code.length);
  };
  /** Where `s` is in `name`'s block, checked to come before anything is recorded or sent. */
  const first = (name: string, s: string) => {
    const b = block(name);
    const at = b.indexOf(s);
    expect(at, `${name}: ${s}`).toBeGreaterThan(0);
    for (const later of ["data.opLog.put(", "await send(", "runFlow(", "readFrontDoor(", "planSendNow("]) {
      const i = b.indexOf(later);
      if (i >= 0) expect(at, `${name}: ${s} before ${later}`).toBeLessThan(i);
    }
  };

  it("every stake asks before anything is recorded or sent: a new one, one carried on, a deposit of wallet TAO", () => {
    for (const name of ["stake", "resumeStake", "depositWalletTao"]) first(name, 'allows("stake")');
  });

  it("every way to USDC asks, and nothing that sells nothing: Receive TAO, a claim as TAO, a cancel", () => {
    first("unstake", 'allows("usdc")');
    first("sellWalletTao", 'allows("usdc")');
    first("claim", 'if (!keepTao) allows("usdc")');
    expect(block("resumeClaim")).toContain('if (!op.keepTao) allows("usdc")');
    for (const name of ["receiveTao", "cancel"]) expect(block(name), name).not.toContain("allows(");
    expect(code).toMatch(/const allows = \(what: "stake" \| "usdc"\) => assertSiteAllows\(what, \{ stage: data\.stage, usdcDelivery: data\.usdcDelivery \}\);/);
  });

  it("Send it now tells the plan whether the deployment is retired", () => {
    expect(block("sendNow")).toContain('retired: data.stage === "retired"');
  });

  it("turning off USDC delivery sends the one clearing call, held by no switch (Task 60 follow-up)", () => {
    const b = block("turnOffDelivery");
    expect(b).toContain('flow("delivery"');
    expect(b).toMatch(/runFlow\(port\(\), scratchStore\(\), \[clearDeliveryCall\(d\(\)\)\]\)/);
    expect(b).not.toContain("allows(");
  });
});

describe("turning off USDC delivery for an account (Task 60 follow-up)", () => {
  it("is exactly setDelivery(0, 0, 0) on the front door: a zero floor clears the preference, and it works while paused", () => {
    const c = clearDeliveryCall(D32);
    expect(c).toEqual({ key: "clearDelivery", to: D32.frontDoor, abi: FRONT_DOOR_V32, functionName: "setDelivery", args: [0n, 0n, 0] });
    expect(c.value).toBeUndefined();
    const data = encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args } as never);
    expect(data).toBe(`${toFunctionSelector("setDelivery(uint128,uint64,uint32)")}${"0".repeat(192)}`);
    const door = readFileSync(fileURLToPath(new URL("../../../../contracts/src/CascadeFrontDoor.sol", import.meta.url)), "utf8");
    // no pause guard on it, and a zero floor deletes the preference before anything else is checked
    expect(door).toMatch(/a zero floor clears it\. Works while paused\.\s*function setDelivery\(uint128 minUsdcPerTao, uint64 deadline, uint32 destination\) external \{/);
    expect(door).toMatch(/function _setDelivery\(uint128 minUsdcPerTao, uint64 deadline, uint32 destination\) internal \{\s*if \(minUsdcPerTao == 0\) \{\s*delete deliveryOf\[msg\.sender\];/);
  });

  it("is v3.2's alone, where the switch is", () => {
    expect(() => clearDeliveryCall(D3)).toThrow(/v3\.2/);
  });
});

// ---- R11 (R12b): the cancel cooldown. A cancel works five minutes after the last deposit to the account's entry ----

describe("a deposit's cancel on v3.2: depositOf first, then the cooldown, then the call run from the account (R11)", () => {
  const START = 1_800_000_000;
  const NOW = START + 1_000;
  const open = (over: Partial<OpenBatch> = {}, mine: Partial<OpenBatch["mine"]> = {}): OpenBatch => ({
    id: 7n,
    start: START,
    interval: 3_600,
    canClose: false,
    paused: false,
    chainTime: NOW,
    mine: { depositWei: 10n ** 17n, redeemShares: 0n, cancelableAt: NOW - 1, ...mine },
    potWei: 0n,
    closesWhilePaused: true,
    ...over,
  });
  const ok = () => vi.fn<(c: FlowCall) => Promise<Simulation>>(async () => ({ ok: true }));
  const plan = (b: OpenBatch | (() => Promise<OpenBatch>), simulate = ok(), batchId: bigint | undefined = 7n) =>
    planCancelDeposit({ d: D32, amount: 10n ** 17n, batchId, read: typeof b === "function" ? b : async () => b, simulate });
  const refused = async (p: Promise<unknown>) => {
    const e = await p.catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FlowError);
    return e as FlowError;
  };

  it("a cancel past its cooldown is run from the account first, then sent: cancelDeposit(amount)", async () => {
    const simulate = ok();
    const c = await plan(open(), simulate);
    expect(c).toEqual(cancelCall("deposit", 10n ** 17n, D32));
    expect(simulate).toHaveBeenCalledExactlyOnceWith(c);
    // 0 is no wait (build B: deposits paused, or batches can't be sent)
    expect(await plan(open({}, { cancelableAt: 0 }))).toEqual(c);
    // exactly at cancelableAt it works (the door refuses only before it)
    expect(await plan(open({}, { cancelableAt: NOW }))).toEqual(c);
  });

  it("depositOf first: a batch that left (no deposit in the open one, or the open one is another batch) says the deposit has left, never a cooldown", async () => {
    const simulate = ok();
    const gone = await refused(plan(open({}, { depositWei: 0n, cancelableAt: NOW + 200 }), simulate));
    expect(gone.message).toBe(CANCEL_LEFT);
    expect(CANCEL_LEFT).toBe("Your deposit has already left with its batch, so it can't be cancelled. Its receipt follows it from here.");
    expect(gone.state).toBe("failed");
    // the account deposited again into the next batch: that one isn't this receipt's to cancel
    expect((await refused(plan(open({ id: 8n }, { cancelableAt: NOW + 200 }), simulate))).message).toBe(CANCEL_LEFT);
    expect(simulate).not.toHaveBeenCalled();
  });

  it("inside the cooldown nothing is sent or run: it says when the cancel opens, by Base's clock", async () => {
    const simulate = ok();
    const soon = await refused(plan(open({}, { cancelableAt: NOW + 185 }), simulate));
    expect(soon.message).toBe("You can cancel this deposit in 3 min 5 s (a cancel works 5 minutes after the last deposit to your entry), so nothing was sent.");
    expect(soon.state).toBe("needs-you");
    expect((await refused(plan(open({}, { cancelableAt: NOW + 40 })))).message).toMatch(/^You can cancel this deposit in 40 s /);
    expect(simulate).not.toHaveBeenCalled();
    // the receipt's words for a hold (R12d: counted on Base's clock, cancelHoldS, below)
    expect(cancelWaitText(300)).toBe("You can cancel this deposit in 5 min 0 s: a cancel works 5 minutes after the last deposit to your entry.");
    expect(cancelWaitText(0)).toBeNull();
  });

  it("a refusal the run finds is said in plain words: CancelTooSoon by the second it names (a deposit to the entry since the read), more than the entry holds, below the minimum", async () => {
    const tooSoon = vi.fn(async (): Promise<Simulation> => ({ ok: false, revert: "CancelTooSoon", args: [BigInt(NOW + 65)] }));
    expect((await refused(plan(open(), tooSoon))).message).toBe("You can cancel this deposit in 1 min 5 s (a cancel works 5 minutes after the last deposit to your entry), so nothing was sent.");
    const less = vi.fn(async (): Promise<Simulation> => ({ ok: false, revert: "InsufficientRequest" }));
    expect((await refused(plan(open(), less))).message).toBe(CANCEL_CHANGED);
    const below = vi.fn(async (): Promise<Simulation> => ({ ok: false, revert: "BelowMinDeposit" }));
    expect((await refused(plan(open(), below))).message).toBe(CANCEL_CHANGED);
    const other = vi.fn(async (): Promise<Simulation> => ({ ok: false }));
    expect((await refused(plan(open(), other))).message).toBe(CANCEL_WONT_GO);
  });

  it("a way out is never held by a read: a batch or a run that can't be read sends the cancel anyway, and the wallet's own estimate decides", async () => {
    const c = await plan(async () => Promise.reject(new Error("HTTP request failed")));
    expect(c).toEqual(cancelCall("deposit", 10n ** 17n, D32));
    expect(await plan(open(), vi.fn(async () => Promise.reject(new Error("timeout"))))).toEqual(c);
    // v3-launch has no cooldown: nothing read, the call as it was
    const read = vi.fn(async () => open());
    expect(await planCancelDeposit({ d: D3, amount: 1n, batchId: 7n, read, simulate: ok() })).toEqual(cancelCall("deposit", 1n, D3));
    expect(read).not.toHaveBeenCalled();
  });

  it("a wallet that refuses to send a cancel inside its cooldown (its estimate reverts CancelTooSoon) names the wait, never an unknown error", async () => {
    const now = Math.floor(Date.now() / 1000);
    const err = new ContractFunctionExecutionError(
      new ContractFunctionRevertedError({
        abi: FRONT_DOOR_V32,
        functionName: "cancelDeposit",
        data: encodeErrorResult({ abi: FRONT_DOOR_V32, errorName: "CancelTooSoon", args: [BigInt(now + 120)] }),
      }),
      { abi: FRONT_DOOR_V32, functionName: "cancelDeposit", args: [1n] },
    );
    expect(revertReason(err)).toBe("CancelTooSoon");
    expect(revertArgs(err)).toEqual([BigInt(now + 120)]);
    const t = tracker();
    const p = port({ send: vi.fn(async () => Promise.reject(err)) });
    const e = await runFlow(p, t.store as never, [cancelCall("deposit", 1n, D32)]).catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/^You can cancel this deposit in (1 min 5[0-9] s|2 min 0 s) \(a cancel works 5 minutes after the last deposit to your entry\), so nothing was sent\.$/);
    expect((e as FlowError).state).toBe("needs-you");
    // mined and reverted (a deposit to the entry landed first): said as a cancel's, not as any step's
    const mined = port({ wait: vi.fn(async () => ({ status: "reverted" as const })) });
    const r = await runFlow(mined, tracker().store as never, [cancelCall("deposit", 1n, D32)]).catch((x: unknown) => x);
    expect((r as Error).message).toBe(CANCEL_REVERTED);
  });
});

// ---- R12d: the cancel on Base's clock (M1), waiting on nothing it doesn't use (M2), and its words (the lows) ----

describe("R12d (M1): the receipt counts a deposit's cancel wait on Base's clock, never the device's alone", () => {
  /** Base's clock at the read (the block's time), and this device's when the read landed (ms): any value, as only the
   * time since the read is counted on it */
  const CHAIN = 1_800_000_000;
  const READ = 1_700_000_000_000;
  const clock = { chainTime: CHAIN, readAt: READ };
  const words = (s: string) => `You can cancel this deposit in ${s}: a cancel works 5 minutes after the last deposit to your entry.`;

  it("the hold runs to cancelableAt on Base's clock (the block's time at the read, plus the time since by this device), and CANCEL_MARGIN_S more, so the first click isn't refused by a block a second behind", () => {
    expect(CANCEL_MARGIN_S).toBeGreaterThanOrEqual(2);
    expect(CANCEL_MARGIN_S).toBeLessThanOrEqual(3);
    expect(cancelHoldS(CHAIN + 200, clock, READ)).toBe(200 + CANCEL_MARGIN_S);
    expect(cancelHoldS(CHAIN + 200, clock, READ + 100_000)).toBe(100 + CANCEL_MARGIN_S);
    expect(cancelHoldS(CHAIN + 200, clock, READ + (200 + CANCEL_MARGIN_S) * 1000)).toBe(0);
    // part of a second left still holds it
    expect(cancelHoldS(CHAIN + 200, clock, READ + (200 + CANCEL_MARGIN_S) * 1000 - 400)).toBe(1);
    // past it, or 0 (build B: no wait)
    expect(cancelHoldS(CHAIN - 5, clock, READ)).toBe(0);
    expect(cancelHoldS(0, clock, READ)).toBe(0);
  });

  it("a device clock 20 minutes slow or fast holds the cancel just as long: only the time since the read is the device's", () => {
    for (const skewMs of [-20 * 60_000, 20 * 60_000]) {
      // the device's clock at the read: Base's, 20 minutes off
      const readAt = CHAIN * 1000 + skewMs;
      const c = { chainTime: CHAIN, readAt };
      expect(cancelHoldS(CHAIN + 200, c, readAt), String(skewMs)).toBe(200 + CANCEL_MARGIN_S);
      expect(cancelHoldS(CHAIN + 200, c, readAt + 60_000), String(skewMs)).toBe(140 + CANCEL_MARGIN_S);
      expect(cancelWaitText(cancelHoldS(CHAIN + 200, c, readAt + 60_000)), String(skewMs)).toBe(words(`2 min ${20 + CANCEL_MARGIN_S} s`));
      expect(cancelHoldS(CHAIN + 200, c, readAt + (200 + CANCEL_MARGIN_S) * 1000), String(skewMs)).toBe(0);
    }
  });

  it("never held more than CANCEL_COOLDOWN_S (and the margin) past the read, whatever it read; a device clock set back since holds no longer", () => {
    expect(cancelHoldS(CHAIN + 3_600, clock, READ)).toBe(CANCEL_COOLDOWN_S + CANCEL_MARGIN_S);
    expect(cancelHoldS(CHAIN + 3_600, clock, READ + 60_000)).toBe(CANCEL_COOLDOWN_S + CANCEL_MARGIN_S - 60);
    expect(cancelHoldS(CHAIN + 3_600, clock, READ + (CANCEL_COOLDOWN_S + CANCEL_MARGIN_S) * 1000)).toBe(0);
    expect(cancelHoldS(CHAIN + 200, clock, READ - 600_000)).toBe(200 + CANCEL_MARGIN_S);
  });

  it("the worded wait is 1 s to 5 minutes", () => {
    expect(cancelWaitText(0)).toBeNull();
    expect(cancelWaitText(1)).toBe(words("1 s"));
    expect(cancelWaitText(0.3)).toBe(words("1 s"));
    expect(cancelWaitText(CANCEL_COOLDOWN_S + CANCEL_MARGIN_S)).toBe(words("5 min 0 s"));
    expect(cancelWaitText(3_600)).toBe(words("5 min 0 s"));
  });

  it("what a screen reader is told is the state, once as it changes, never each second's count", () => {
    expect(CANCEL_WAITING_STATUS).toBe("This deposit's cancel opens 5 minutes after the last deposit to your entry.");
    expect(CANCEL_OPEN_STATUS).toBe("You can cancel this deposit now.");
  });

  it("a wallet's CancelTooSoon (worded by this device's clock: runFlow has no block's) is clamped to 1 s to 5 minutes: a clock 20 minutes slow says 5 min, not 25", async () => {
    const now = Math.floor(Date.now() / 1000);
    const tooSoon = (at: number) =>
      new ContractFunctionExecutionError(
        new ContractFunctionRevertedError({ abi: FRONT_DOOR_V32, functionName: "cancelDeposit", data: encodeErrorResult({ abi: FRONT_DOOR_V32, errorName: "CancelTooSoon", args: [BigInt(at)] }) }),
        { abi: FRONT_DOOR_V32, functionName: "cancelDeposit", args: [1n] },
      );
    // Base 20 minutes ahead of this device (its clock slow): 25 minutes by it; Base 20 minutes behind (fast): past
    for (const [at, said] of [
      [now + 1_500, "5 min 0 s"],
      [now - 900, "1 s"],
    ] as const) {
      const p = port({ send: vi.fn(async () => Promise.reject(tooSoon(at))) });
      const e = await runFlow(p, tracker().store as never, [cancelCall("deposit", 1n, D32)]).catch((x: unknown) => x);
      expect((e as Error).message, String(at)).toBe(`You can cancel this deposit in ${said} (a cancel works 5 minutes after the last deposit to your entry), so nothing was sent.`);
    }
  });
});

describe("R12d (M2): a deposit's cancel waits on nothing it doesn't use, and on what it does for CANCEL_CHECK_MS at most", () => {
  const NOW = 1_800_001_000;
  /** The cancel's own read (reads.ts readCancelState): the open batch's id, Base's clock, the account's deposit and cooldown */
  const mine = (over: Partial<OpenBatch["mine"]> = {}) => ({ id: 7n, chainTime: NOW, mine: { depositWei: 10n ** 17n, cancelableAt: NOW - 1, ...over } });
  const c = cancelCall("deposit", 10n ** 17n, D32);
  const ok = () => vi.fn<(c: FlowCall) => Promise<Simulation>>(async () => ({ ok: true }));
  type Read = () => Promise<ReturnType<typeof mine>>;
  /** planCancelDeposit on fake time: whether it settled `ms` after the click, and with what */
  async function after(ms: number, read: Read, simulate: (c: FlowCall) => Promise<Simulation>) {
    vi.useFakeTimers();
    try {
      const r: { done: boolean; out?: unknown } = { done: false };
      void planCancelDeposit({ d: D32, amount: 10n ** 17n, batchId: 7n, read, simulate }).then(
        (x) => Object.assign(r, { done: true, out: x }),
        (e: unknown) => Object.assign(r, { done: true, out: e }),
      );
      await vi.advanceTimersByTimeAsync(ms);
      return r;
    } finally {
      vi.useRealTimers();
    }
  }
  const hung = () => new Promise<never>(() => undefined);

  it("about five seconds", () => {
    expect(CANCEL_CHECK_MS).toBe(5_000);
  });

  it("its read is the cancel's own small one (no fee, price, log or Bittensor read in it): that is all a check takes", async () => {
    const simulate = ok();
    expect(await planCancelDeposit({ d: D32, amount: 10n ** 17n, batchId: 7n, read: async () => mine(), simulate })).toEqual(c);
    expect(simulate).toHaveBeenCalledExactlyOnceWith(c);
    const soon = await planCancelDeposit({ d: D32, amount: 10n ** 17n, batchId: 7n, read: async () => mine({ cancelableAt: NOW + 40 }), simulate: ok() }).catch((x: unknown) => x);
    expect((soon as FlowError).message).toMatch(/^You can cancel this deposit in 40 s /);
  });

  it("a read that hangs: the cancel goes at CANCEL_CHECK_MS, as on a failed read, and the wallet's own estimate decides", async () => {
    const simulate = ok();
    expect((await after(CANCEL_CHECK_MS - 1, hung, simulate)).done).toBe(false);
    expect(await after(CANCEL_CHECK_MS, hung, simulate)).toEqual({ done: true, out: c });
    expect(simulate).not.toHaveBeenCalled();
  });

  it("a run that hangs after a slow read: the same, within the same five seconds of the click", async () => {
    const slow: Read = () => new Promise((r) => setTimeout(() => r(mine()), 4_000));
    expect((await after(CANCEL_CHECK_MS - 1, slow, hung)).done).toBe(false);
    expect(await after(CANCEL_CHECK_MS, slow, hung)).toEqual({ done: true, out: c });
    // and what the read finds in time still refuses: a cooldown found at 4 s says so then
    const soon: Read = () => new Promise((r) => setTimeout(() => r(mine({ cancelableAt: NOW + 40 })), 4_000));
    const refused = await after(4_000, soon, hung);
    expect(refused.done).toBe(true);
    expect((refused.out as FlowError).message).toMatch(/^You can cancel this deposit in 40 s /);
  });

  it("use-flows.ts's cancel reads readCancelState, never the open batch's whole read (data.getOpenBatch: its fee quotes, prices, log scan and Bittensor)", () => {
    const code = readFileSync(fileURLToPath(new URL("./use-flows.ts", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const start = code.indexOf("\n    cancel: (");
    expect(start).toBeGreaterThan(0);
    const next = /\n {4}[A-Za-z]+(: \(|\()/g;
    next.lastIndex = start + 1;
    const body = code.slice(start, next.exec(code)?.index ?? code.length);
    expect(body).toContain("read: () => readCancelState(data.clients, d(), a)");
    expect(body).not.toContain("getOpenBatch");
  });
});

describe("R12d: a cancel's words", () => {
  const NOW = 1_800_001_000;
  const ok = () => vi.fn<(c: FlowCall) => Promise<Simulation>>(async () => ({ ok: true }));
  const plan = (id: bigint, depositWei: bigint) =>
    planCancelDeposit({ d: D32, amount: 10n ** 17n, batchId: 7n, read: async () => ({ id, chainTime: NOW, mine: { depositWei, cancelableAt: NOW - 1 } }), simulate: ok() }).catch((x: unknown) => x as FlowError);

  it("a read a block behind the receipt's batch (an open id below the receipt's) says try again in a moment, never that the deposit left", async () => {
    for (const depositWei of [0n, 10n ** 17n]) {
      const e = await plan(6n, depositWei);
      expect(e).toBeInstanceOf(FlowError);
      expect((e as FlowError).message).toBe(CANCEL_BEHIND);
      expect((e as FlowError).state).toBe("needs-you");
    }
    expect(CANCEL_BEHIND).toBe("The reading from Base is a moment behind your deposit, so nothing was sent. Try again in a moment.");
    // a later batch open, or none of the account's in this one: it has left
    expect(((await plan(8n, 10n ** 17n)) as FlowError).message).toBe(CANCEL_LEFT);
    expect(((await plan(7n, 0n)) as FlowError).message).toBe(CANCEL_LEFT);
  });

  it("a cancel mined and reverted names the cooldown only for v3.2's cancelDeposit: an unstake's cancel, and v3-launch's (no cooldown), say only that the batch may have left", async () => {
    const said = async (c: FlowCall) => {
      const mined = port({ wait: vi.fn(async () => ({ status: "reverted" as const })) });
      return ((await runFlow(mined, tracker().store as never, [c]).catch((x: unknown) => x)) as Error).message;
    };
    expect(await said(cancelCall("deposit", 1n, D32))).toBe(CANCEL_REVERTED);
    expect(CANCEL_REVERTED).toContain("5-minute wait");
    for (const c of [cancelCall("withdrawal", 1n, D32), cancelCall("deposit", 1n, D3), cancelCall("withdrawal", 1n, D3)]) expect(await said(c), `${c.functionName} ${c.abi === FRONT_DOOR ? "v3-launch" : "v3.2"}`).toBe(CANCEL_REVERTED_LEFT);
    expect(CANCEL_REVERTED_LEFT).toBe("The cancel didn't go through on Base: its batch may have just left. Only Base's network fee was spent.");
  });
});

describe("R12e: a cancel sent without its check (its read or its run didn't answer) reads, once it lands, which batch it came out of, and says so", () => {
  const NOW = 1_800_001_000;
  const mine = (over: Partial<OpenBatch["mine"]> = {}) => ({ id: 7n, chainTime: NOW, mine: { depositWei: 10n ** 17n, cancelableAt: NOW - 1, ...over } });
  const c = cancelCall("deposit", 10n ** 17n, D32);
  const ok = () => vi.fn<(c: FlowCall) => Promise<Simulation>>(async () => ({ ok: true }));
  const hung = () => new Promise<never>(() => undefined);
  /** planCancelDeposit on fake time, `ms` after the click: what it settled with, and whether it said the cancel went unchecked */
  async function after(ms: number, read: () => Promise<ReturnType<typeof mine>>, simulate: (c: FlowCall) => Promise<Simulation>) {
    vi.useFakeTimers();
    try {
      const r: { out?: unknown; unchecked: number } = { unchecked: 0 };
      void planCancelDeposit({ d: D32, amount: 10n ** 17n, batchId: 7n, read, simulate, unchecked: () => r.unchecked++ }).then(
        (x) => Object.assign(r, { out: x }),
        (e: unknown) => Object.assign(r, { out: e }),
      );
      await vi.advanceTimersByTimeAsync(ms);
      return r;
    } finally {
      vi.useRealTimers();
    }
  }

  it("planCancelDeposit says when the call goes without its check: a read that fails or hangs (the batch id unchecked), a run that hangs; never when both answer, nor when it refuses", async () => {
    expect(await after(0, () => Promise.reject(new Error("down")), ok())).toEqual({ out: c, unchecked: 1 });
    expect(await after(CANCEL_CHECK_MS, hung, ok())).toEqual({ out: c, unchecked: 1 });
    expect(await after(CANCEL_CHECK_MS, async () => mine(), hung)).toEqual({ out: c, unchecked: 1 });
    expect(await after(0, async () => mine(), ok())).toEqual({ out: c, unchecked: 0 });
    const left = await after(0, async () => mine({ depositWei: 0n }), ok());
    expect((left.out as FlowError).message).toBe(CANCEL_LEFT);
    expect(left.unchecked).toBe(0);
  });

  it("cancelOutcomeNote: nothing read or said for a checked cancel; for one sent unchecked, nothing when it came out of this deposit's batch, and else which batch it came out of, or that Base can't show it yet", async () => {
    const took = vi.fn(async () => true as boolean | undefined);
    expect(await cancelOutcomeNote({ unchecked: false, took })).toBeUndefined();
    expect(took).not.toHaveBeenCalled();
    expect(await cancelOutcomeNote({ unchecked: true, took })).toBeUndefined();
    expect(await cancelOutcomeNote({ unchecked: true, took: async () => false })).toBe(CANCEL_SENT_FROM_LATER);
    expect(await cancelOutcomeNote({ unchecked: true, took: async () => undefined })).toBe(CANCEL_SENT_UNREAD);
    expect(await cancelOutcomeNote({ unchecked: true, took: () => Promise.reject(new Error("down")) })).toBe(CANCEL_SENT_UNREAD);
    expect(CANCEL_SENT_FROM_LATER).toBe(
      "This cancel went without its check (Base didn't answer in time), and this deposit's batch had already left: the cancel came out of your deposit in the batch open now, and that TAO is back in your wallet. This deposit goes on with its batch.",
    );
    expect(CANCEL_SENT_UNREAD).toBe(
      "This cancel went without its check (Base didn't answer in time), and Base can't show yet which batch it came out of. If this deposit still shows as on its way once it can, its batch had already left, and the cancel came out of your deposit in the batch open now.",
    );
  });

  it("use-flows.ts's cancel says so: it passes `unchecked` to planCancelDeposit and, once the cancel landed, sets cancelOutcomeNote's words, read by cancelTook (facts.ts: the batch the receipt's DepositCancelled names)", () => {
    const code = readFileSync(fileURLToPath(new URL("./use-flows.ts", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    const start = code.indexOf("\n    cancel: (");
    expect(start).toBeGreaterThan(0);
    const next = /\n {4}[A-Za-z]+(: \(|\()/g;
    next.lastIndex = start + 1;
    const body = code.slice(start, next.exec(code)?.index ?? code.length);
    expect(body).toContain("unchecked: () =>");
    // (the cancel's store is kept, so its mark can be taken back: below)
    expect(body).toMatch(/const store = cancelStore\(data\.opLog, a, id\);\s*await runFlow\(wallet, store, \[c\]\);[\s\S]*await cancelOutcomeNote\(\{ unchecked, took \}\)/);
    expect(body).toContain("cancelTook(data.clients, d(), op, batchId)");
    expect(body).toContain("setError(note)");
    // every cancel that went through is read back from its own receipt, a deposit's and an unstake's alike (cancelConfirmed
    // around cancelTook), the note for one sent unchecked said from that same reading, and the record settled by it
    // (op-store.ts settleCancel): confirmed, its mark taken back on a definite no, or left on its way
    expect(body).toMatch(/await runFlow\(wallet, store, \[c\]\);[\s\S]*const outcome = await cancelConfirmed\(async \(\) => \{[\s\S]*cancelTook\(data\.clients, d\(\), op, batchId\);\s*\}\);[\s\S]*const took = async \(\) => outcome;[\s\S]*if \(note\) setError\(note\);\s*settleCancel\(store, data\.opLog, a, id, read\.hash, outcome\);/);
    expect(body).toContain('if (op?.kind !== "deposit" && op?.kind !== "withdrawal") return undefined;');
    // 1b: the cancel settled is the one that receipt was read for: the record's mark at that very read
    expect(body).toMatch(/const op = data\.opLog\.get\(a, id\);[\s\S]*read\.hash = op\.cancelled\?\.hash;\s*return cancelTook\(data\.clients, d\(\), op, batchId\);/);
    // nothing marks a record confirmed, or takes its mark back, but that settling
    expect(body).not.toContain("confirmCancel(");
    expect(body.split("settleCancel(").length - 1).toBe(1);
  });

  it("cancelConfirmed: what the cancel's own receipt says, read for CANCEL_CHECK_MS at most: took the record out, definitely didn't, or not known; the three are never run together", async () => {
    expect(await cancelConfirmed(async () => true)).toBe(true);
    // its receipt was read and it didn't take the record out (no cancel of the account's in it, or another batch's): a
    // definite no, at once, so its mark can be taken back and the cancel offered again
    expect(await cancelConfirmed(async () => false)).toBe(false);
    // a read that failed says nothing either way
    expect(await cancelConfirmed(() => Promise.reject(new Error("down")))).toBeUndefined();
    vi.useFakeTimers();
    try {
      /** cancelConfirmed on fake time: whether it has settled `ms` after it was asked, with what, and how often it read */
      const after = async (ms: number, took: (n: number) => Promise<boolean | undefined>) => {
        const r: { done: boolean; out?: boolean | undefined; reads: number } = { done: false, reads: 0 };
        void cancelConfirmed(() => took(++r.reads)).then((x) => Object.assign(r, { done: true, out: x }));
        await vi.advanceTimersByTimeAsync(ms);
        return r;
      };
      // a receipt Base can't show yet (the wallet's node saw it first) is read again, and answers once it can
      expect(CANCEL_CONFIRM_EVERY_MS).toBeLessThan(CANCEL_CHECK_MS / 4);
      const late = (n: number) => Promise.resolve(n < 3 ? undefined : true);
      expect(await after(2 * CANCEL_CONFIRM_EVERY_MS - 1, late)).toEqual({ done: false, reads: 2 });
      expect(await after(2 * CANCEL_CONFIRM_EVERY_MS, late)).toEqual({ done: true, out: true, reads: 3 });
      expect(await after(CANCEL_CONFIRM_EVERY_MS, (n) => Promise.resolve(n < 2 ? undefined : false))).toEqual({ done: true, out: false, reads: 2 });
      // never readable, or a read that hangs: the flow is held no longer than the cancel's own check is, and the answer is
      // "not known" (undefined), never a no: an unreadable receipt takes no mark back
      const never = () => Promise.resolve(undefined);
      expect((await after(CANCEL_CHECK_MS - 1, never)).done).toBe(false);
      const unread = await after(CANCEL_CHECK_MS, never);
      expect(unread.done).toBe(true);
      expect(unread.out).toBeUndefined();
      const hung = () => new Promise<never>(() => undefined);
      expect(await after(CANCEL_CHECK_MS - 1, hung)).toEqual({ done: false, reads: 1 });
      const stuck = await after(CANCEL_CHECK_MS, hung);
      expect(stuck).toMatchObject({ done: true, reads: 1 });
      expect(stuck.out).toBeUndefined();
      // and it leaves no timer running, however it ended
      await vi.advanceTimersByTimeAsync(CANCEL_CHECK_MS);
      expect(await cancelConfirmed(async () => true)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---- ChatGPT r3 §2 (R12b): a request to a full redeem list closes the batch first on its pot alone ----

describe("a new unstake request to a full redeem list whose pot can't pay the close (InsufficientFee) is refused before anything is sent", () => {
  const open = (over: Partial<OpenBatch> = {}, mine: Partial<OpenBatch["mine"]> = {}): OpenBatch => ({
    id: 7n,
    start: 1_800_000_000,
    interval: 3_600,
    canClose: true,
    paused: false,
    chainTime: 1_800_000_100,
    mine: { depositWei: 0n, redeemShares: 0n, ...mine },
    potWei: 5n * 10n ** 15n,
    feeWei: 6n * 10n ** 15n,
    nRedeems: 50,
    maxRedeems: 50,
    closesWhilePaused: true,
    ...over,
  });

  it("redeemCloseShort: the list full, no request of the account's in it, the pot under the bridge fee", () => {
    expect(redeemCloseShort(open())).toBe(true);
    // the pot covers it: the request's own close goes
    expect(redeemCloseShort(open({ potWei: 6n * 10n ** 15n }))).toBe(false);
    // a request of the account's already in it: the new one adds to it, nothing closes
    expect(redeemCloseShort(open({}, { redeemShares: 1n }))).toBe(false);
    // room in the list
    expect(redeemCloseShort(open({ nRedeems: 49 }))).toBe(false);
    // the fee unread: can't be told
    expect(redeemCloseShort(open({ feeWei: undefined }))).toBeUndefined();
    // v3-launch (no limit read)
    expect(redeemCloseShort(open({ nRedeems: undefined, maxRedeems: undefined }))).toBe(false);
  });

  /** R12d (M2): the list as its small read gives it (full, none of the account's), and the batch with its fee */
  const FULL_LIST = { nRedeems: 50, maxRedeems: 50, redeemShares: 0n };
  const check = (batch: () => Promise<OpenBatch>, list = async () => FULL_LIST) => assertRedeemListOpen(D32, { list, batch });

  it("assertRedeemListOpen refuses in plain words, needs-you; anything it can't tell (a read that fails, the fee unread) lets the wallet's estimate decide", async () => {
    const e = await check(async () => open()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FlowError);
    expect((e as FlowError).message).toBe(REDEEM_LIST_FULL);
    expect((e as FlowError).state).toBe("needs-you");
    expect(REDEEM_LIST_FULL).toBe(
      "The current batch's unstake list is full and its fees don't cover sending it, so a new unstake would fail until it leaves. It normally leaves within a minute or two, at no cost to you: try again then. Nothing was sent.",
    );
    await expect(check(async () => open({ potWei: 10n ** 16n }))).resolves.toBeUndefined();
    await expect(check(async () => open({ feeWei: undefined }))).resolves.toBeUndefined();
    await expect(check(async () => Promise.reject(new Error("down")))).resolves.toBeUndefined();
    await expect(check(async () => open(), async () => Promise.reject(new Error("down")))).resolves.toBeUndefined();
    const list = vi.fn(async () => FULL_LIST);
    const batch = vi.fn(async () => open());
    await expect(assertRedeemListOpen(D3, { list, batch })).resolves.toBeUndefined();
    expect(list).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it("R12d (M2): the list's own read first (its count, its limit, the account's request); the fee is quoted only for a full list with none of the account's in it, so a hung fee quote never holds an unstake the list has room for", async () => {
    const hung = vi.fn(() => new Promise<OpenBatch>(() => undefined));
    const settles = (p: Promise<void>) => Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 50))]);
    // room in the list: nothing more read
    expect(await settles(check(hung, async () => ({ ...FULL_LIST, nRedeems: 49 })))).toBe(true);
    // a request of the account's in it: the new one adds to it, closing nothing
    expect(await settles(check(hung, async () => ({ ...FULL_LIST, redeemShares: 1n })))).toBe(true);
    expect(hung).not.toHaveBeenCalled();
    // full, none of the account's: the batch and its fee are read, and a short pot refuses
    const batch = vi.fn(async () => open());
    await expect(check(batch)).rejects.toThrow(REDEEM_LIST_FULL);
    expect(batch).toHaveBeenCalledOnce();
  });

  it("both ways to ask (a USDC unstake, Receive TAO) check it before the request is recorded, the list by its own small read and the fee by the batch's (R12d: the comments stripped, so a comment naming it can't pass)", () => {
    const code = readFileSync(fileURLToPath(new URL("./use-flows.ts", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
    /** One entry of the object useFlows returns, up to the next one (delivery-limit.test.ts's helper). */
    const block = (name: string) => {
      const start = code.indexOf(`\n    ${name}: (`);
      expect(start, name).toBeGreaterThan(0);
      const next = /\n {4}[A-Za-z]+(: \(|\()/g;
      next.lastIndex = start + 1;
      const end = next.exec(code)?.index ?? code.length;
      return code.slice(start, end);
    };
    for (const name of ["unstake", "receiveTao"]) {
      const body = block(name);
      expect(body, name).toContain("await assertRedeemListOpen(d(), { list: () => readRedeemList(data.clients, d(), a), batch: () => data.getOpenBatch(a) });");
      expect(body.indexOf("assertRedeemListOpen("), name).toBeLessThan(body.indexOf("data.opLog.put("));
    }
  });
});
