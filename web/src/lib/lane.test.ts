import { describe, expect, it } from "vitest";
import { deriveLane } from "./lane";
import type { DepositRecord, StakeProof } from "./cascade/types";

const proof: StakeProof = {
  allStaked: true,
  stakedTao: 3.86,
  owedTao: 3.86,
  checkedAt: new Date(),
  validatorHotkey: "5F",
  explorerUrl: "https://x/stake",
};

const steps = (active: number) =>
  (["received", "swapped", "bridged", "staked"] as const).map((key, i) => ({
    key,
    title: key,
    status: i < active ? "done" : i === active ? "active" : "pending",
  })) as DepositRecord["steps"];

const dep = (id: string, tao: number, active: number): DepositRecord => ({
  id,
  createdAt: new Date(),
  amountUsd: 500,
  sourceChain: "base",
  status: active >= 4 ? "staked" : "in_progress",
  steps: steps(active),
  taoAmount: tao,
  feesUsd: 1.9,
  taoPriceUsd: 271.18,
  rewardsTao: 0,
});

describe("deriveLane", () => {
  it("shows one deposit's phrase and step", () => {
    const [w, t, s] = deriveLane({ usdcBalance: 2400, deposits: [dep("a", 2.03, 2)], proof });
    expect(w).toEqual({ amount: "2,400 USDC", label: "in your wallet on Base", state: "muted" });
    expect(t).toEqual({ amount: "2.03 TAO", label: "crossing to Bittensor, step 3 of 4", state: "live" });
    expect(s).toEqual({
      amount: "3.86 TAO",
      label: "staked on Bittensor",
      state: "done",
      href: "https://x/stake",
    });
  });

  it("adds up several deposits in transit", () => {
    const [, t] = deriveLane({
      usdcBalance: 0,
      deposits: [dep("a", 1, 1), dep("b", 2.5, 3), dep("c", 9, 4)],
      proof,
    });
    expect(t).toEqual({ amount: "3.50 TAO", label: "2 deposits on their way", state: "live" });
  });

  it("mutes empty nodes and keeps the lane shape", () => {
    const lane = deriveLane({ usdcBalance: null, deposits: [], proof: { ...proof, stakedTao: 0 } });
    expect(lane.map((n) => n.state)).toEqual(["muted", "muted", "muted"]);
    expect(lane[0].amount).toBe("–");
    expect(lane[1].label).toBe("nothing in transit");
    expect(lane[2].label).toBe("nothing staked yet");
  });

  it("says it is checking while the proof loads", () => {
    expect(deriveLane({ usdcBalance: 1, deposits: [], proof: null })[2]).toEqual({
      amount: "–",
      label: "checking",
      state: "muted",
    });
  });
});

describe("deriveLane when a query failed", () => {
  it("says the check is unavailable instead of checking forever", () => {
    expect(deriveLane({ usdcBalance: 1, deposits: [], proof: null, proofError: true })[2]).toEqual({
      amount: "–",
      label: "check unavailable",
      state: "muted",
    });
  });
});
