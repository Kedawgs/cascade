import { describe, expect, it } from "vitest";
import { deriveLane } from "./lane";
import type { DepositRecord, Position } from "./cascade/types";

const position = (tao: number): Position => ({
  shares: 0n,
  availableShares: 0n,
  taoWei: 0n,
  availableTaoWei: 0n,
  taoBalance: tao,
  usdValue: tao * 250,
  taoPriceUsd: 250,
  pendingTao: 0,
  avgEntryPriceUsd: null,
});

const steps = (active: number) =>
  (["swap", "deposit", "bridge", "stake"] as const).map((key, i) => ({
    key,
    title: key,
    status: i < active ? "done" : i === active ? "active" : "pending",
  })) as DepositRecord["steps"];

const dep = (id: string, tao: number, active: number): DepositRecord => ({
  id,
  createdAt: new Date(),
  amountUsd: 20,
  sourceChain: "base",
  status: active >= 4 ? "staked" : "in_progress",
  steps: steps(active),
  taoWei: 0n,
  taoAmount: tao,
});

const VAULT = "https://taostats.io/account/5FNE";

describe("deriveLane", () => {
  it("shows one deposit's phrase and step, and the account's own stake", () => {
    const [w, t, s] = deriveLane({ usdcBalance: 2400, deposits: [dep("a", 0.0788, 2)], position: position(0.05), explorerUrl: VAULT });
    expect(w).toEqual({ amount: "2,400 USDC", label: "in your wallet on Base", state: "muted" });
    expect(t).toEqual({ amount: "0.08 TAO", label: "crossing to Bittensor, step 3 of 4", state: "live" });
    expect(s).toEqual({ amount: "0.05 TAO", label: "yours, staked on Bittensor", state: "done", href: VAULT });
  });

  it("adds up several deposits in transit", () => {
    const [, t] = deriveLane({ usdcBalance: 0, deposits: [dep("a", 1, 1), dep("b", 2.5, 3), dep("c", 9, 4)], position: position(0) });
    expect(t).toEqual({ amount: "3.50 TAO", label: "2 deposits on their way", state: "live" });
  });

  it("mutes empty nodes and keeps the lane shape", () => {
    const lane = deriveLane({ usdcBalance: null, deposits: [], position: position(0) });
    expect(lane.map((n) => n.state)).toEqual(["muted", "muted", "muted"]);
    expect(lane[0].amount).toBe("–");
    expect(lane[1].label).toBe("nothing in transit");
    expect(lane[2].label).toBe("nothing staked yet");
  });

  it("says it is checking while the position loads, and when the check failed", () => {
    expect(deriveLane({ usdcBalance: 1, deposits: [], position: null })[2]).toEqual({ amount: "–", label: "checking", state: "muted" });
    expect(deriveLane({ usdcBalance: 1, deposits: [], position: null, positionError: true })[2]).toEqual({
      amount: "–",
      label: "check unavailable",
      state: "muted",
    });
  });
});
