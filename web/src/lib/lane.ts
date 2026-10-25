import type { DepositRecord, DepositStepKey, Position } from "./cascade/types";
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
  /** The account's own position (its share of the vault), or null while it loads. */
  position: Position | null;
  /** True when the position query failed, so the lane says so instead of "checking" forever. */
  positionError?: boolean;
  /** Where the vault's stake can be seen on Bittensor. */
  explorerUrl?: string;
}

/** Plain words for what a deposit in progress is doing right now. */
export const TRANSIT_PHRASE: Record<DepositStepKey, string> = {
  swap: "swapping for TAO",
  deposit: "joining the next batch",
  bridge: "crossing to Bittensor",
  stake: "being staked",
};

/** Wallet, in transit, staked. The lane always has three nodes; empty ones are muted, not hidden. */
export function deriveLane(input: LaneInput): [LaneNode, LaneNode, LaneNode] {
  const wallet: LaneNode =
    input.usdcBalance === null
      ? { amount: "–", label: "balance unavailable", state: "muted" }
      : { amount: `${formatUsdc(input.usdcBalance)} USDC`, label: "in your wallet on Base", state: "muted" };

  const moving = input.deposits.filter((d) => d.status === "in_progress" || d.status === "needs_you");
  const movingTao = moving.reduce((sum, d) => sum + d.taoAmount, 0);
  let transit: LaneNode;
  if (moving.length === 0) {
    transit = { amount: "0 TAO", label: "nothing in transit", state: "muted" };
  } else if (moving.length === 1) {
    const steps = moving[0].steps;
    const activeIndex = Math.max(0, steps.findIndex((s) => s.status === "active" || s.status === "action"));
    const phrase = steps[activeIndex]?.summary ?? TRANSIT_PHRASE[steps[activeIndex]?.key ?? "swap"];
    transit = { amount: `${formatTao(movingTao, 2)} TAO`, label: `${phrase}, step ${activeIndex + 1} of 4`, state: "live" };
  } else {
    transit = { amount: `${formatTao(movingTao, 2)} TAO`, label: `${moving.length} deposits on their way`, state: "live" };
  }

  let staked: LaneNode;
  if (input.positionError) {
    staked = { amount: "–", label: "check unavailable", state: "muted" };
  } else if (!input.position) {
    staked = { amount: "–", label: "checking", state: "muted" };
  } else if (input.position.taoBalance > 0) {
    staked = {
      amount: `${formatTao(input.position.taoBalance, 2)} TAO`,
      label: "yours, staked on Bittensor",
      state: "done",
      ...(input.explorerUrl ? { href: input.explorerUrl } : {}),
    };
  } else {
    staked = { amount: "0 TAO", label: "nothing staked yet", state: "muted" };
  }

  return [wallet, transit, staked];
}
