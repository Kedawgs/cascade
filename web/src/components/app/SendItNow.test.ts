import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { createElement } from "react";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { type CloseOp, createOpLog, type DepositOp, type Operation } from "@/lib/cascade/oplog";
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

/** Batch 7 as read just now, ten minutes in: the account's deposit is in it, it can't close yet, and its
 * fees don't cover its bridge fee. */
const open = (over: Partial<OpenBatch> = {}): OpenBatch => ({
  id: 7n,
  start: START,
  interval: 3_600,
  canClose: false,
  paused: false,
  chainTime: START + 600,
  mine: { depositWei: 10n ** 17n, redeemShares: 0n },
  potWei: 0n,
  economics: { feesUsdc: 430_000n, bridgeFeeUsdc: 1_735_000n },
  ...over,
});
/** Two hours in it can close, Bittensor can take it, and what sending it costs has been read. */
const ready = (over: Partial<OpenBatch> = {}) =>
  open({
    canClose: true,
    chainTime: START + 7_200,
    economics: undefined,
    bittensor: "open",
    feeWei: 744_898_037_875_672n,
    ethWei: 10n ** 16n,
    gasWei: 10n ** 13n,
    ethPriceUsd: 2_330,
    ...over,
  });
const batchRead = (b: OpenBatch, at = Date.now()): Cached => ({ key: cascadeKeys.openBatch(ME), data: b, at });

function withOps(...ops: Operation[]) {
  const m = new Map<string, string>();
  const log = createOpLog({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }, ME);
  for (const o of ops) log.put(o);
  return launchData(log);
}

const card = (cached: Cached[], waiting = true, ops: Operation[] = [], what: "deposit" | "unstake" = "deposit") =>
  renderWithCache(createElement(SendItNow, { account: ME, what, waiting, href: "/activity?deposit=d1" }), cached, { data: withOps(...ops) });

/** The buttons a page shows, by their words. */
const buttons = (h: string) => [...h.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

describe("Send it now on a deposit waiting in the open batch", () => {
  it("before it's offered: a countdown to when the batch leaves, and to five minutes past its interval, when the user can send it", () => {
    const text = plainText(card([batchRead(open())]));
    expect(text).toContain("Leaves in 23 h 50 min (by 8:00 AM tomorrow), or sooner.");
    expect(text).toContain("Send it yourself in 55 min (from 9:05 AM).");
    expect(text).not.toContain("Send it now");
  });

  it("offers nothing while its fees cover the bridge fee: the keeper sends it at its interval", () => {
    const text = plainText(card([batchRead(open({ economics: { feesUsdc: 2_000_000n, bridgeFeeUsdc: 1_735_000n } }))]));
    expect(text).toBe("Leaves within the hour: its fees cover the bridge fee.");
  });

  it("offers nothing when the keeper sends it for free: full, or past its max wait", () => {
    expect(plainText(card([batchRead(ready({ chainTime: START + 600 }))]))).toBe("Leaves any moment now.");
    expect(plainText(card([batchRead(ready({ chainTime: START + 86_460 }))]))).toBe("Leaves any moment now.");
  });

  it("offers nothing when Bittensor's side can't take the batch, and says it can still be cancelled", () => {
    expect(plainText(card([batchRead(ready({ bittensor: "paused" }))]))).toBe(
      "Bittensor's side isn't accepting batches right now; your deposit waits on Base and you can still cancel it.",
    );
    expect(plainText(card([batchRead(ready({ bittensor: "paused" }))], true, [], "unstake"))).toContain("your unstake waits on Base");
  });

  it("offers nothing when Bittensor's side couldn't be checked, and says so rather than calling it paused", () => {
    expect(plainText(card([batchRead(ready({ bittensor: "unchecked" }))]))).toBe(
      "We couldn't check Bittensor's side just now; your deposit waits on Base and you can still cancel it. Try again in a minute.",
    );
  });

  it("offers it again once the keeper is overdue, five minutes past the max wait", () => {
    const h = card([batchRead(ready({ chainTime: START + 86_400 + 400 }))]);
    expect(plainText(h)).toContain("It was due to leave by 8:00 AM and hasn't left yet; you can send it yourself.");
    expect(h).toMatch(/<button[^>]*>Send it now: about \$1\.74<\/button>/);
  });

  it("once it can close: the button with the fee in dollars, and that it is paid in ETH and what the wallet sends at most", () => {
    const h = card([batchRead(ready())]);
    const text = plainText(h);
    expect(text).toContain("Leaves in 22 h (by 8:00 AM tomorrow), or sooner.");
    expect(h).toMatch(/<button type="button" class="pill pill-ghost[^"]*"[^>]*>Send it now: about \$1\.74<\/button>/);
    expect(h).not.toMatch(/<button[^>]*disabled=""[^>]*>Send it now/);
    expect(text).toContain("You pay the whole batch's bridge fee, in ETH. Up to $2.26 is sent; any extra is refunded.");
  });

  it("holds the button and says how much ETH it needs when the wallet is short", () => {
    const h = card([batchRead(ready({ ethWei: 0n }))]);
    expect(h).toMatch(/<button[^>]*disabled=""[^>]*>Send it now: about \$1\.74<\/button>/);
    expect(plainText(h)).toContain("You need about $2.29 of ETH on Base for this.");
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
    expect(text).toContain("Send it now: about $1.74");
    // and not once it has left its batch
    const gone = page(createElement(DepositDetail, { account: ME, id: "d1" }), [{ key: cascadeKeys.deposits(ME), data: [deposit({ cancellableWei: undefined })] }, batchRead(ready())]);
    expect(gone).not.toContain("Send it now");
  });

  it("on the receipt of an unstake still in its open batch", () => {
    const b = ready({ mine: { depositWei: 0n, redeemShares: 10n ** 21n } });
    const text = page(createElement(WithdrawalDetail, { account: ME, id: "w1" }), [{ key: cascadeKeys.withdrawals(ME), data: [unstake] }, batchRead(b)]);
    expect(text).toContain("Send it now: about $1.74");
  });

  it("in Where your money is, under the lane, while a deposit waits in its open batch", () => {
    const text = page(createElement(WhereIsMyMoney, { account: ME }), [{ key: cascadeKeys.deposits(ME), data: [deposit()] }, batchRead(open())]);
    expect(text).toContain("Leaves in 23 h 50 min (by 8:00 AM tomorrow)");
    expect(text).toContain("Send it yourself in 55 min (from 9:05 AM).");
  });

  it("in Where your money is, once it can be sent: the line, the one Send it now pill in its row, and its note; no cancel there", () => {
    const h = renderWithCache(routed(createElement(WhereIsMyMoney, { account: ME })), [{ key: cascadeKeys.deposits(ME), data: [deposit()] }, batchRead(ready())], { data: withOps() });
    expect(h).toMatch(/<div class="[^"]*_row_[^"]*"><button type="button" class="pill pill-ghost">Send it now: about \$1\.74<\/button><\/div>/);
    expect(buttons(h)).toEqual(["Send it now: about $1.74"]);
    const text = plainText(h);
    expect(text).toContain("Leaves in 22 h (by 8:00 AM tomorrow), or sooner.");
    expect(text).toContain("You pay the whole batch's bridge fee, in ETH. Up to $2.26 is sent; any extra is refunded.");
    expect(text).not.toContain("Cancel");
  });

  it("not in Where your money is for a deposit this browser has already cancelled, though the list, read before, still shows it in its batch", () => {
    const op = (over: Partial<DepositOp> = {}): DepositOp => ({ id: "d1", kind: "deposit", v: 3, account: ME, createdAt: Date.now() - 3_600_000, usdcIn: 25_000_000n, targetTao: 10n ** 17n, hashes: { stake: H(1) }, batchId: 7n, state: "sent", ...over });
    const lane = (...ops: Operation[]) => renderWithCache(routed(createElement(WhereIsMyMoney, { account: ME })), [{ key: cascadeKeys.deposits(ME), data: [deposit()] }, batchRead(ready())], { data: withOps(...ops) });
    for (const cancelled of [{ hash: H(9), at: Date.now() - 5_000 }, { hash: H(9), at: Date.now() - 5_000, confirmed: true as const }]) {
      const h = lane(op({ cancelled }));
      expect(buttons(h), JSON.stringify(cancelled)).toEqual([]);
      expect(plainText(h), JSON.stringify(cancelled)).not.toContain("Leaves in");
    }
    // no cancel of its own, or another deposit's: offered as before
    expect(buttons(lane(op()))).toEqual(["Send it now: about $1.74"]);
    expect(buttons(lane(op(), op({ id: "d2", cancelled: { hash: H(9), at: Date.now() - 5_000, confirmed: true } })))).toEqual(["Send it now: about $1.74"]);
  });
});

describe("a receipt's own button in the block's row (`action`), and its small print (`actionNote`)", () => {
  const cancel = createElement("button", { type: "button", className: "pill pill-ghost" }, "Cancel deposit");
  const note = createElement("p", null, "You can cancel in a moment.");
  const withAction = (cached: Cached[], waiting = true, extra: { action?: typeof cancel; actionNote?: typeof note } = { action: cancel, actionNote: note }) =>
    renderWithCache(createElement(SendItNow, { account: ME, what: "deposit", waiting, href: "/activity?deposit=d1", ...extra }), cached, { data: withOps() });
  const row = (h: string) => /<div class="[^"]*_row_[^"]*">((?:<button\b[^>]*>[^<]*<\/button>)+)<\/div>/.exec(h)?.[1];

  it("sits beside Send it now, after it, in the one row; its note comes under the row, after Send it now's own", () => {
    const h = withAction([batchRead(ready())]);
    expect(row(h)).toBe('<button type="button" class="pill pill-ghost">Send it now: about $1.74</button><button type="button" class="pill pill-ghost">Cancel deposit</button>');
    expect(h.split("_row_").length - 1).toBe(1);
    expect(h.indexOf("_row_")).toBeLessThan(h.indexOf("You pay the whole batch"));
    expect(h.indexOf("You pay the whole batch")).toBeLessThan(h.indexOf("You can cancel in a moment."));
    // the wallet short of ETH: Send it now is held with its reason, the receipt's button isn't
    const short = withAction([batchRead(ready({ ethWei: 0n }))]);
    expect(row(short)).toBe('<button type="button" class="pill pill-ghost" disabled="">Send it now: about $1.74</button><button type="button" class="pill pill-ghost">Cancel deposit</button>');
    expect(short.indexOf("You need about $2.29 of ETH on Base for this.")).toBeLessThan(short.indexOf("You can cancel in a moment."));
  });

  it("shows alone, filling the row, whatever the block has to show: before Send it now is offered, in place of a send on its way, and with nothing at all", () => {
    const alone = '<button type="button" class="pill pill-ghost">Cancel deposit</button>';
    // before it is offered
    const early = withAction([batchRead(open())]);
    expect(row(early)).toBe(alone);
    expect(plainText(early)).toContain("Send it yourself in 55 min (from 9:05 AM).");
    // a send from this browser on its way
    const sent: CloseOp = { id: "c1", kind: "close", account: ME, createdAt: Date.now() - 60_000, batchId: 7n, value: 969_000_000_000_000n, hashes: { close: H(5) }, state: "running" };
    const sending = renderWithCache(createElement(SendItNow, { account: ME, what: "deposit", waiting: true, href: "/activity", action: cancel, actionNote: note }), [batchRead(ready())], { data: withOps(sent) });
    expect(row(sending)).toBe(alone);
    expect(plainText(sending)).toContain("Sending your batch to Bittensor…");
    // nothing of the batch to show: not read, nothing of the account's in it, paused, the contracts not matching, not waiting
    const nothing: [string, string][] = [
      ["unread", withAction([])],
      ["none of the account's", withAction([batchRead(ready({ mine: { depositWei: 0n, redeemShares: 0n } }))])],
      ["paused", withAction([batchRead(ready({ paused: true }))])],
      ["the contracts don't match", withAction([batchRead(ready()), { key: ["wiring"], data: "mismatch" }])],
      ["not waiting", withAction([batchRead(ready())], false)],
    ];
    for (const [why, h] of nothing) {
      expect(row(h), why).toBe(alone);
      expect(plainText(h), why).toBe("Cancel depositYou can cancel in a moment.");
    }
  });

  it("without one, the block is as it was: nothing when it has nothing to show", () => {
    expect(withAction([], true, {})).not.toContain("_box_");
    expect(plainText(withAction([batchRead(ready())], true, {}))).not.toContain("Cancel");
  });
});
