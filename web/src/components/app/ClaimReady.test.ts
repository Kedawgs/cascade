import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { cascadeKeys } from "@/lib/cascade/hooks";
import type { WithdrawalRecord } from "@/lib/cascade/records";
import { CLAIM_CHECKING } from "@/lib/stake-form";
import { launchData, plainText, renderWithCache } from "../test-render";
import { ClaimReady } from "./StakeCard";

const ME = "0x1234567890abcdef1234567890abcdef12345678";
const waiting = 10n ** 16n;
const unstake = (returnStatus: "checking" | "active"): WithdrawalRecord => ({
  id: "w1",
  createdAt: new Date(0),
  status: "in_progress",
  steps: [
    { key: "request", title: "Request your unstake", status: "done" },
    { key: "unstake", title: "Unstake on Bittensor", status: "done" },
    { key: "return", title: "Return to Base", status: returnStatus },
    { key: "claim", title: "USDC to your wallet", status: "pending" },
  ],
  shares: 1n,
  taoAmount: 0.01,
  claimable: waiting,
  awaitingDelivery: true,
});
const banner = (w: WithdrawalRecord) =>
  plainText(
    renderWithCache(
      createElement(ClaimReady, { account: ME }),
      [
        { key: cascadeKeys.balances(ME), data: { claimable: waiting } },
        { key: cascadeKeys.withdrawals(ME), data: [w] },
      ],
      { data: launchData() },
    ),
  );

describe("the Stake page's claim banner on v3 (review 2)", () => {
  it("suggests no claim by hand while an unstake that may be delivering is still being checked, and keeps Claim as TAO", () => {
    const t = banner(unstake("checking"));
    expect(t).toContain("is back on Base.");
    expect(t).toContain(CLAIM_CHECKING);
    expect(t).toContain("Claim as TAO");
    expect(t).not.toContain("Claim as USDC");
    expect(t).not.toContain("ready to claim");
  });

  it("offers Claim as USDC as before once that unstake's steps are known and none is delivering", () => {
    const t = banner(unstake("active"));
    expect(t).toContain("ready to claim");
    expect(t).toContain("Claim as USDC");
    expect(t).not.toContain(CLAIM_CHECKING);
  });
});
