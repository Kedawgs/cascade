import type { DepositRecord, DepositStepKey, StakeProof } from "./cascade/types";
import { formatTao, formatUsdc } from "./format";

/** One of the three stops in "Where your money is right now". */
export interface LaneNode {
  amount: string;
  label: string;
  state: "muted" | "live" | "done";
  href?: string;
}

export interface LaneInput {
  /** USDC in the wallet, or null while unknown. */
  usdcBalance: number | null;
  deposits: DepositRecord[];
  proof: StakeProof | null;
}

/** Plain words for what a deposit in progress is doing right now. */
export const TRANSIT_PHRASE: Record<DepositStepKey, string> = {
  received: "waiting for your USDC",
  swapped: "swapping for TAO",
  bridged: "crossing to Bittensor",
  staked: "being staked",
};

/** Wallet, in transit, staked. The lane always has three nodes; empty ones are muted, not hidden. */
export function deriveLane(input: LaneInput): [LaneNode, LaneNode, LaneNode] {
  const wallet: LaneNode =
    input.usdcBalance === null
      ? { amount: "–", label: "balance unavailable", state: "muted" }
      : { amount: `${formatUsdc(input.usdcBalance)} USDC`, label: "in your wallet on Base", state: "muted" };

  const moving = input.deposits.filter((d) => d.status === "in_progress");
  const movingTao = moving.reduce((sum, d) => sum + d.taoAmount, 0);
  let transit: LaneNode;
  if (moving.length === 0) {
    transit = { amount: "0 TAO", label: "nothing in transit", state: "muted" };
  } else if (moving.length === 1) {
    const steps = moving[0].steps;
    const activeIndex = Math.max(0, steps.findIndex((s) => s.status === "active"));
    const key = steps[activeIndex]?.key ?? "received";
    transit = {
      amount: `${formatTao(movingTao, 2)} TAO`,
      label: `${TRANSIT_PHRASE[key]}, step ${activeIndex + 1} of 4`,
      state: "live",
    };
  } else {
    transit = {
      amount: `${formatTao(movingTao, 2)} TAO`,
      label: `${moving.length} deposits on their way`,
      state: "live",
    };
  }

  let staked: LaneNode;
  if (!input.proof) {
    staked = { amount: "–", label: "checking", state: "muted" };
  } else if (input.proof.stakedTao > 0) {
    staked = {
      amount: `${formatTao(input.proof.stakedTao, 2)} TAO`,
      label: "staked on Bittensor",
      state: "done",
      href: input.proof.explorerUrl,
    };
  } else {
    staked = { amount: "0 TAO", label: "nothing staked yet", state: "muted" };
  }

  return [wallet, transit, staked];
}
