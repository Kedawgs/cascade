import { createElement } from "react";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { ActivityTab } from "@/lib/activity-params";
import { cascadeKeys } from "@/lib/cascade/hooks";
import { createOpLog, type DepositOp, type Operation, type WithdrawalOp } from "@/lib/cascade/oplog";
import { pendingEntry } from "@/lib/cascade/pending";
import type { DepositRecord, WithdrawalRecord } from "@/lib/cascade/records";
import { launchData, plainText, renderWithCache } from "../test-render";
import { Lists, PendingReceipt } from "./ActivityScreen";

const ME = "0x1234567890abcdef1234567890abcdef12345678";
const at = new Date("2026-10-28T12:00:00Z");

const deposit: DepositRecord = {
  id: "d1",
  createdAt: at,
  sourceChain: "base",
  status: "staked",
  steps: [{ key: "stake", title: "Stake on Bittensor", status: "done" }],
  taoWei: 10n ** 17n,
  taoAmount: 0.1,
  amountUsd: 25,
};

const unstake = (over: Partial<WithdrawalRecord> = {}): WithdrawalRecord => ({
  id: "w1",
  createdAt: at,
  status: "in_progress",
  steps: [{ key: "return", title: "Return to Base", status: "active" }],
  shares: 10n ** 17n,
  taoAmount: 0.07,
  usdcAmount: 17.41,
  claimable: 0n,
  ...over,
});

const html = (tab: ActivityTab, withdrawals: WithdrawalRecord[]) =>
  renderWithCache(createElement(Lists, { account: ME, tab }), [
    { key: cascadeKeys.deposits(ME), data: [deposit] },
    { key: cascadeKeys.withdrawals(ME), data: withdrawals },
  ]);

describe("Activity lists", () => {
  it("shows one list at a time, with both tabs' counts", () => {
    const text = plainText(html("deposits", [unstake()]));
    expect(text).toContain("Deposits: 1Unstakes: 1");
    expect(text).toContain("$25 from Base");
    expect(text).not.toContain("17.41");
    expect(plainText(html("unstakes", [unstake()]))).not.toContain("$25 from Base");
  });

  it("marks the open tab", () => {
    expect(html("unstakes", [unstake()])).toMatch(/aria-current="page"[^>]*>Unstakes/);
  });

  it("puts a dot on Unstakes while money is ready to claim, so it can't hide behind Deposits", () => {
    expect(plainText(html("deposits", [unstake({ status: "ready" })]))).toContain("Unstakes: 1, money ready to claim");
    expect(plainText(html("deposits", [unstake()]))).not.toContain("ready to claim");
  });

  it("puts no dot on what stays flagged after it's dealt with (a daily-limit unstake, a claim whose swap failed)", () => {
    const dailyLimit = unstake({ status: "needs_you", unstakeAgain: true, steps: [{ key: "unstake", title: "Unstake on Bittensor", status: "action" }] });
    const swapFailed = unstake({ status: "needs_you", steps: [{ key: "claim", title: "Swap it to USDC", status: "action" }] });
    expect(plainText(html("deposits", [dailyLimit, swapFailed]))).not.toContain("ready to claim");
  });

  it("says so when there are no unstakes yet", () => {
    expect(plainText(html("unstakes", []))).toContain("No unstakes yet.");
  });

  it("shows the open tab as soon as its own list is read, without waiting for the other", () => {
    const h = renderWithCache(createElement(Lists, { account: ME, tab: "deposits" }), [{ key: cascadeKeys.deposits(ME), data: [deposit] }]);
    expect(plainText(h)).toContain("$25 from Base");
    expect(plainText(h)).toContain("Deposits: 1Unstakes");
  });
});

/** An op log holding `ops`, in memory, behind the launch deployment. */
function withOps(...ops: Operation[]) {
  const m = new Map<string, string>();
  const log = createOpLog({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }, ME);
  for (const o of ops) log.put(o);
  return launchData(log);
}

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
/** A $50 stake this browser sent a minute ago, quoted at 0.19461 TAO. */
const sentDeposit = (): DepositOp => ({
  id: "d9",
  kind: "deposit",
  v: 3,
  account: ME,
  createdAt: Date.now() - 60_000,
  usdcIn: 50_000_000n,
  targetTao: 194_610_000_000_000_000n,
  minTaoOut: 193_600_000_000_000_000n,
  priceUsd: 256.9,
  hashes: { stake: H(1) },
  state: "sent",
});
const sentUnstake = (): WithdrawalOp => ({
  id: "w9",
  kind: "withdrawal",
  account: ME,
  createdAt: Date.now() - 60_000,
  shares: 7n * 10n ** 16n,
  taoEstimate: 7n * 10n ** 16n,
  usdcEstimate: 17_410_000n,
  fee: 10n ** 14n,
  hash: H(2),
  state: "sent",
});
/** Its record as the chain reads it: the stake's receipt deposited 0.19482 TAO, not the quote's 0.19461. */
const readDeposit: DepositRecord = { ...deposit, id: "d9", amountUsd: 50, taoWei: 194_820_000_000_000_000n, taoAmount: 0.19482, status: "in_progress" };
/** How many links to `href` the page has. */
const links = (h: string, href: string) => h.split(`href="${href}"`).length - 1;

describe("a deposit or unstake just sent, before Activity has read it", () => {
  const list = (tab: ActivityTab, cached: Parameters<typeof renderWithCache>[1], ...ops: Operation[]) =>
    renderWithCache(createElement(Lists, { account: ME, tab }), cached, { data: withOps(...ops) });

  it("shows at once, said to be unconfirmed, with the amount sent and the TAO estimate", () => {
    const h = list("deposits", [], sentDeposit());
    const text = plainText(h);
    expect(links(h, "/activity?deposit=d9")).toBe(1);
    expect(text).toContain("$50 from Base");
    expect(text).toContain("about 0.1946 TAO");
    expect(text).toContain("Confirming");
    expect(text).toContain("sent, not confirmed yet");
    // the rest of the history is still being read
    expect(text).toContain("Reading the rest from Base and Bittensor");
    // no count is given until the list is read
    expect(text).not.toMatch(/Deposits: \d/);
  });

  it("gives way to its record once the list is read: one row, with the chain's figures only", () => {
    const h = list("deposits", [{ key: cascadeKeys.deposits(ME), data: [readDeposit] }], sentDeposit());
    const text = plainText(h);
    expect(links(h, "/activity?deposit=d9")).toBe(1);
    expect(text).toContain("0.1948 TAO");
    expect(text).not.toContain("0.1946");
    expect(text).not.toContain("Confirming");
    expect(text).toContain("Deposits: 1");
  });

  it("shows above a list read before it was sent (cached from the Stake page), counted with it", () => {
    const h = list("deposits", [{ key: cascadeKeys.deposits(ME), data: [deposit] }], sentDeposit());
    const text = plainText(h);
    expect(links(h, "/activity?deposit=d9")).toBe(1);
    expect(links(h, "/activity?deposit=d1")).toBe(1);
    expect(text.indexOf("$50 from Base")).toBeLessThan(text.indexOf("$25 from Base"));
    expect(text).toContain("Deposits: 2");
    expect(text).not.toContain("No deposits yet");
  });

  it("an unstake: shows at once with its USDC estimate, then gives way to its record", () => {
    const before = list("unstakes", [{ key: cascadeKeys.deposits(ME), data: [] }], sentUnstake());
    expect(links(before, "/activity?withdrawal=w9")).toBe(1);
    expect(plainText(before)).toContain("about 17.41 USDC");
    expect(plainText(before)).toContain("Confirming");
    const after = list("unstakes", [{ key: cascadeKeys.withdrawals(ME), data: [unstake({ id: "w9" })] }], sentUnstake());
    expect(links(after, "/activity?withdrawal=w9")).toBe(1);
    expect(plainText(after)).not.toContain("Confirming");
  });

  it("shows nothing it can't stand behind: a stake that stopped, one taken back out, or one from last week", () => {
    const stopped = { ...sentDeposit(), state: "needs-you" as const };
    const cancelled = { ...sentDeposit(), cancelled: { hash: H(3), at: Date.now() } };
    const old = { ...sentDeposit(), createdAt: Date.now() - 8 * 24 * 60 * 60_000 };
    for (const op of [stopped, cancelled, old]) expect(plainText(list("deposits", [], op))).not.toContain("Confirming");
  });
});

describe("a receipt opened before Activity has read it", () => {
  const card = (op: Operation) => {
    const entry = pendingEntry(op);
    if (!entry) throw new Error("no entry");
    return renderWithCache(createElement(PendingReceipt, { entry }), [], { data: withOps(op) });
  };

  it("a deposit: where it's going, said plainly to be unconfirmed, with its transaction on Base", () => {
    const h = card(sentDeposit());
    const text = plainText(h);
    expect(text).toContain("Where your $50 is going");
    expect(text).toContain("Submitted, confirming…");
    expect(text).toContain("not confirmed here yet");
    expect(text).toContain("Amount50 USDC");
    expect(text).toContain("TAO (estimate)about 0.1946 TAO");
    expect(h).toContain(`href="https://basescan.org/tx/${H(1)}"`);
    expect(h).toContain('href="/activity"');
  });

  it("an unstake: its estimates and its request on Base", () => {
    const h = card(sentUnstake());
    const text = plainText(h);
    expect(text).toContain("Your unstake of about $17.41");
    expect(text).toContain("Submitted, confirming…");
    expect(text).toContain("You will receiveabout 17.41 USDC");
    expect(h).toContain(`href="https://basescan.org/tx/${H(2)}"`);
    expect(h).toContain('href="/activity?tab=unstakes"');
  });
});
