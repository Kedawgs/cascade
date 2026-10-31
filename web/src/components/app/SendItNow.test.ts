import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { createElement } from "react";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { type CloseOp, createOpLog, type Operation } from "@/lib/cascade/oplog";
import type { DepositRecord, WithdrawalRecord } from "@/lib/cascade/records";
import type { OpenBatch } from "@/lib/cascade/types";
import { type Cached, launchData, plainText, renderWithCache } from "../test-render";
import { DepositDetail, WithdrawalDetail } from "./ActivityScreen";
import { SendItNow } from "./SendItNow";
import { WhereIsMyMoney } from "./WhereIsMyMoney";

const ME = "0x1234567890abcdef1234567890abcdef12345678";
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
/** 8:00 AM UTC (the tests read times in UTC). */
const START = 1_800_000_000;

/** Batch 7 as read just now, ten minutes in: the account's deposit is in it, and it can't close yet. */
const open = (over: Partial<OpenBatch> = {}): OpenBatch => ({
  id: 7n,
  start: START,
  interval: 3_600,
  canClose: false,
  paused: false,
  chainTime: START + 600,
  mine: { depositWei: 10n ** 17n, redeemShares: 0n },
  potWei: 0n,
  ...over,
});
/** Two hours in it can close, and what sending it costs has been read. */
const ready = (over: Partial<OpenBatch> = {}) =>
  open({ canClose: true, chainTime: START + 7_200, feeWei: 744_898_037_875_672n, ethWei: 10n ** 16n, gasWei: 10n ** 13n, ethPriceUsd: 2_330, ...over });
const batchRead = (b: OpenBatch, at = Date.now()): Cached => ({ key: cascadeKeys.openBatch(ME), data: b, at });

function withOps(...ops: Operation[]) {
  const m = new Map<string, string>();
  const log = createOpLog({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }, ME);
  for (const o of ops) log.put(o);
  return launchData(log);
}

const card = (cached: Cached[], waiting = true, ops: Operation[] = []) =>
  renderWithCache(createElement(SendItNow, { account: ME, waiting, href: "/activity?deposit=d1" }), cached, { data: withOps(...ops) });

describe("Send it now on a deposit waiting in the open batch", () => {
  it("before the batch can close: a countdown to when it leaves, and to when the user can send it", () => {
    const text = plainText(card([batchRead(open())]));
    expect(text).toContain("Leaves in 23 h 50 min (by 8:00 AM tomorrow), or sooner if more deposits share the bridge fee.");
    expect(text).toContain("Send it yourself in 50 min (from 9:00 AM).");
    expect(text).not.toContain("Send it now");
  });

  it("once it can close: the button with the fee in dollars of ETH, and what the wallet sends at most", () => {
    const h = card([batchRead(ready())]);
    const text = plainText(h);
    expect(text).toContain("Leaves in 22 h (by 8:00 AM tomorrow), or sooner if more deposits share the bridge fee.");
    expect(h).toMatch(/<button type="button" class="pill pill-ghost[^"]*"[^>]*>Send it now: about \$1\.74 in ETH<\/button>/);
    expect(h).not.toMatch(/<button[^>]*disabled=""[^>]*>Send it now/);
    expect(text).toContain("You pay the bridge fee for the whole batch. Your wallet sends up to $2.26 in ETH; anything extra is refunded.");
  });

  it("holds the button and says how much ETH it needs when the wallet is short", () => {
    const h = card([batchRead(ready({ ethWei: 0n }))]);
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>Send it now: about \$1\.74 in ETH<\/button>/);
    expect(plainText(h)).toContain("You need about $2.28 of ETH on Base for this.");
  });

  it("says when the batch's fees already cover it", () => {
    expect(plainText(card([batchRead(ready({ potWei: 2n * 10n ** 15n }))]))).toContain("Send it now: no bridge fee to pay");
  });

  it("shows dashes, never a time or a fee, once the read is stale, and holds the button", () => {
    const h = card([batchRead(ready(), Date.now() - 200_000)]);
    expect(plainText(h)).toContain("Leaves in –");
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>Send it now: about –<\/button>/);
    expect(plainText(card([batchRead(open(), Date.now() - 200_000)]))).toContain("Send it yourself in –");
  });

  it("shows nothing while the batch hasn't been read, when nothing of the account's waits in it, or while paused", () => {
    expect(plainText(card([]))).toBe("");
    expect(plainText(card([batchRead(ready())], false))).toBe("");
    expect(plainText(card([batchRead(ready({ mine: { depositWei: 0n, redeemShares: 0n } }))]))).toBe("");
    expect(plainText(card([batchRead(ready({ paused: true }))]))).toBe("");
  });

  it("shows a send from this browser as on its way, with its transaction, in place of the button", () => {
    const sent: CloseOp = { id: "c1", kind: "close", account: ME, createdAt: Date.now() - 60_000, batchId: 7n, value: 969_000_000_000_000n, hashes: { close: H(5) }, state: "running" };
    const h = card([batchRead(ready())], true, [sent]);
    expect(plainText(h)).toContain("Sending your batch to Bittensor…");
    expect(h).toContain(`href="https://basescan.org/tx/${H(5)}"`);
    expect(h).not.toContain("Send it now");
  });
});

describe("where Send it now shows", () => {
  const at = new Date("2026-10-30T12:00:00Z");
  const router = { push: () => undefined, replace: () => undefined, back: () => undefined, forward: () => undefined, refresh: () => undefined, prefetch: () => undefined };
  const routed = (el: ReturnType<typeof createElement>) => createElement(AppRouterContext.Provider, { value: router as never }, el);
  const deposit = (over: Partial<DepositRecord> = {}): DepositRecord => ({
    id: "d1",
    createdAt: at,
    sourceChain: "base",
    status: "in_progress",
    steps: [{ key: "bridge", title: "Cross to Bittensor", status: "active" }],
    taoWei: 10n ** 17n,
    taoAmount: 0.1,
    amountUsd: 25,
    cancellableWei: 10n ** 17n,
    ...over,
  });
  const unstake: WithdrawalRecord = {
    id: "w1",
    createdAt: at,
    status: "in_progress",
    steps: [{ key: "unstake", title: "Unstake on Bittensor", status: "active" }],
    shares: 10n ** 21n,
    taoAmount: 0.07,
    usdcAmount: 17.41,
    claimable: 0n,
    cancellableShares: 10n ** 21n,
  };
  const page = (el: ReturnType<typeof createElement>, cached: Cached[]) => plainText(renderWithCache(routed(el), cached, { data: withOps() }));

  it("on the receipt of a deposit still in its open batch", () => {
    const text = page(createElement(DepositDetail, { account: ME, id: "d1" }), [{ key: cascadeKeys.deposits(ME), data: [deposit()] }, batchRead(ready())]);
    expect(text).toContain("Send it now: about $1.74 in ETH");
    // and not once it has left its batch
    const gone = page(createElement(DepositDetail, { account: ME, id: "d1" }), [{ key: cascadeKeys.deposits(ME), data: [deposit({ cancellableWei: undefined })] }, batchRead(ready())]);
    expect(gone).not.toContain("Send it now");
  });

  it("on the receipt of an unstake still in its open batch", () => {
    const b = ready({ mine: { depositWei: 0n, redeemShares: 10n ** 21n } });
    const text = page(createElement(WithdrawalDetail, { account: ME, id: "w1" }), [{ key: cascadeKeys.withdrawals(ME), data: [unstake] }, batchRead(b)]);
    expect(text).toContain("Send it now: about $1.74 in ETH");
  });

  it("in Where your money is, under the lane, while a deposit waits in its open batch", () => {
    const text = page(createElement(WhereIsMyMoney, { account: ME }), [{ key: cascadeKeys.deposits(ME), data: [deposit()] }, batchRead(open())]);
    expect(text).toContain("Leaves in 23 h 50 min (by 8:00 AM tomorrow)");
    expect(text).toContain("Send it yourself in 50 min (from 9:00 AM).");
  });
});
