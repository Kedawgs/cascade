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
  /** TAO sitting in the wallet on Base. */
  walletTao?: number;
  deposits: DepositRecord[];
  /** The account's own position (its share of the vault), or null while it loads. */
  position: Position | null;
  /** True when the position query failed, so the lane says so instead of "checking" forever. */
  positionError?: boolean;
  /** Where the vault's stake can be seen on Bittensor. */
  explorerUrl?: string;
  /** The vault holds TAO it can't stake yet (below Bittensor's minimum); undefined until checked. */
  waitingForMinimum?: boolean;
  minimumTao?: number;
}

/** Small amounts keep four decimals, so a test-sized 0.0117 doesn't read as 0.01. */
const tao = (n: number) => `${formatTao(n, n < 1 ? 4 : 2)} TAO`;

/** On its way: swapped out of USDC (so no longer in the wallet) and not yet in the vault (where the
 * position counts it). Failed and cancelled ones are not moving. */
const onItsWay = (d: DepositRecord) =>
  (d.status === "in_progress" || d.status === "needs_you") &&
  d.steps.find((s) => s.key === "swap")?.status === "done" &&
  d.steps.find((s) => s.key === "bridge")?.status !== "done";

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
      : {
          amount: `${formatUsdc(input.usdcBalance)} USDC${input.walletTao ? ` + ${tao(input.walletTao)}` : ""}`,
          label: "in your wallet on Base",
          state: "muted",
        };

  const moving = input.deposits.filter(onItsWay);
  const movingTao = moving.reduce((sum, d) => sum + d.taoAmount, 0);
  let transit: LaneNode;
  if (moving.length === 0) {
    transit = { amount: "0 TAO", label: "nothing in transit", state: "muted" };
  } else if (moving.length === 1) {
    const steps = moving[0].steps;
    const activeIndex = Math.max(0, steps.findIndex((s) => s.status === "active" || s.status === "action"));
    const phrase = steps[activeIndex]?.summary ?? TRANSIT_PHRASE[steps[activeIndex]?.key ?? "swap"];
    transit = { amount: tao(movingTao), label: `${phrase}, step ${activeIndex + 1} of 4`, state: "live" };
  } else {
    transit = { amount: tao(movingTao), label: `${moving.length} deposits on their way`, state: "live" };
  }

  let staked: LaneNode;
  if (input.positionError) {
    staked = { amount: "–", label: "check unavailable", state: "muted" };
  } else if (!input.position) {
    staked = { amount: "–", label: "checking", state: "muted" };
  } else if (input.position.taoBalance > 0 && input.waitingForMinimum) {
    staked = {
      amount: tao(input.position.taoBalance),
      label: `yours, in the vault on Bittensor, staked once the vault reaches ${input.minimumTao ?? 0.02} TAO`,
      state: "live",
    };
  } else if (input.position.taoBalance > 0) {
    staked = {
      amount: tao(input.position.taoBalance),
      label: input.waitingForMinimum === undefined ? "yours on Bittensor" : "yours, staked on Bittensor",
      state: "done",
      ...(input.explorerUrl ? { href: input.explorerUrl } : {}),
    };
  } else {
    staked = { amount: "0 TAO", label: "nothing staked yet", state: "muted" };
  }

  return [wallet, transit, staked];
}
