import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { ActivityTab } from "@/lib/activity-params";
import { cascadeKeys } from "@/lib/cascade/hooks";
import type { DepositRecord, WithdrawalRecord } from "@/lib/cascade/records";
import { plainText, renderWithCache } from "../test-render";
import { Lists } from "./ActivityScreen";

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
});
