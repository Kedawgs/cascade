import { formatEther, type Hex, parseAbi } from "viem";
import type { ClaimPolicy } from "../config.ts";
import type { Plan, PlanV3 } from "../plan.ts";
import type { DeploymentRecord } from "../record.ts";
import type { CallRequest } from "../types.ts";

const DAY = 86_400;
const MONTH = 30 * DAY;

const tao = (wei: bigint) => `τ${formatEther(wei)}`;
const usd = (x: number) => `$${x.toFixed(2)}`;
const dayCount = (n: number) => (n === 1 ? "1 day" : `${n} days`);

export interface ClaimInput {
  waitingWei: bigint;
  costWei: bigint;
  taoPriceUsd: number;
  lastClaimAt: number;
  now: number;
  multiple: bigint;
  monthlyMaxUsd: number;
}

/** The reward policy (spec): claim when what is waiting is at least `multiple` times the claim cost (so
 * a claim costs at most 1/multiple of what it collects), or when 30 days have passed since the last
 * claim and a claim costs less than `monthlyMaxUsd` — but never when it would cost more than it collects. */
export function claimDecision(i: ClaimInput): { claim: boolean; reason: string } {
  const threshold = i.multiple * i.costWei;
  const waiting = `${tao(i.waitingWei)} is waiting`;
  if (i.waitingWei >= threshold) {
    return { claim: true, reason: `${waiting}, at least ${i.multiple}× the ${tao(i.costWei)} a claim costs (${tao(threshold)})` };
  }
  const below = `${waiting}, below ${i.multiple}× the ${tao(i.costWei)} a claim costs (${tao(threshold)})`;
  const days = Math.floor((i.now - i.lastClaimAt) / DAY);
  if (i.now - i.lastClaimAt < MONTH) {
    return { claim: false, reason: `${below}, and the last claim was ${dayCount(days)} ago (the monthly claim comes after 30 days)` };
  }
  const costUsd = (Number(i.costWei) / 1e18) * i.taoPriceUsd;
  if (!(costUsd < i.monthlyMaxUsd)) {
    const cost = Number.isFinite(costUsd) ? usd(costUsd) : "an unknown amount (no TAO price)";
    return {
      claim: false,
      reason: `${below}; ${days} days have passed since the last claim, but a claim costs ${cost}, not under the $${i.monthlyMaxUsd} ceiling for monthly claims`,
    };
  }
  if (i.waitingWei <= i.costWei) {
    return { claim: false, reason: `${days} days have passed since the last claim, but a claim would cost ${tao(i.costWei)}, more than the ${tao(i.waitingWei)} waiting` };
  }
  return { claim: true, reason: `${days} days have passed since the last claim, and a claim costs ${usd(costUsd)}, under the $${i.monthlyMaxUsd} ceiling for monthly claims` };
}

/** What the keeper reads for a claim decision: the vault's stake hotkey and what is waiting on it, the
 * last claim, Bittensor's time, TAO's price on Base, and what a claim transaction needs up front. */
export interface RewardsRead {
  hotkey: Hex;
  /** getUnclaimedRootTaoByHotkey(vault coldkey, hotkey), in wei */
  waitingWei: bigint;
  lastClaimAt: number;
  now: number;
  /** USDC for 1 TAO on Uniswap (QuoterV2, TAO -0.3%-> WETH -0.05%-> USDC) */
  taoPriceUsd: number;
  /** The gas the vault requires to be left right before it calls the claim precompile */
  claimGasRequired: bigint;
  gasPriceWei: bigint;
  /** The test wallet's TAO on Bittensor */
  walletWei: bigint;
}

export interface RewardsDeps {
  readRewards(): Promise<RewardsRead>;
}

export const decideClaim = (r: RewardsRead, p: ClaimPolicy) =>
  claimDecision({
    waitingWei: r.waitingWei,
    costWei: p.claimCostTao,
    taoPriceUsd: r.taoPriceUsd,
    lastClaimAt: r.lastClaimAt,
    now: r.now,
    multiple: p.claimMultiple,
    monthlyMaxUsd: p.monthlyClaimMaxUsd,
  });

/** Above the vault's claimGasRequired: the gas the vault spends before its check, and after the claim. */
export const CLAIM_GAS_MARGIN = 2_000_000n;
/** The claim is sent with a fixed gas limit (55M + 2M by default, under Bittensor's 75M block): the
 * precompile refuses less than ~53.2M, and the vault checks claimGasRequired is left before calling it. */
export const claimGasLimit = (claimGasRequired: bigint) => claimGasRequired + CLAIM_GAS_MARGIN;

/** Bittensor takes the whole gas limit's fee up front and refunds what is unused: null when the wallet
 * can pay it, else why not. */
export function upfrontShortfall(r: RewardsRead): string | null {
  const limit = claimGasLimit(r.claimGasRequired);
  const need = limit * r.gasPriceWei;
  if (r.walletWei >= need) return null;
  return `a claim is sent with a ${limit.toLocaleString("en-US")} gas limit, so the wallet needs ${tao(need)} up front (unused gas is refunded); it holds ${tao(r.walletWei)}. Top it up on Bittensor; nothing sent`;
}

/** The vault's own coldkey, from the plan (the vault's first constructor argument). */
export const vaultColdkey = (plan: Plan | PlanV3): Hex => plan.steps.find((s) => s.id === "vault")!.args[0] as Hex;

export const CLAIM_ABI = parseAbi(["function claimRewards(bytes32 hotkey)"]);

export const claimRequest = (rec: DeploymentRecord, hotkey: Hex, gasLimit: bigint, nonce: number): CallRequest => ({
  chain: "bittensor",
  nonce,
  label: `claim the vault's rewards on hotkey ${hotkey.slice(0, 10)}…`,
  to: rec.plan.addresses.vault,
  abi: CLAIM_ABI,
  functionName: "claimRewards",
  args: [hotkey],
  gasLimit,
});

/** `pnpm ops rewards`: what is waiting, the cost, the ratio and the decision. */
export function formatRewards(r: RewardsRead, p: ClaimPolicy): string[] {
  const d = decideClaim(r, p);
  const ratio = Number((r.waitingWei * 10_000n) / p.claimCostTao) / 10_000;
  const days = Math.floor((r.now - r.lastClaimAt) / DAY);
  const limit = claimGasLimit(r.claimGasRequired);
  const at = new Date(r.lastClaimAt * 1000).toISOString().slice(0, 16).replace("T", " ");
  return [
    `Rewards waiting on hotkey ${r.hotkey.slice(0, 10)}…: ${tao(r.waitingWei)}`,
    `Claim cost (estimate): ${tao(p.claimCostTao)} ≈ ${usd((Number(p.claimCostTao) / 1e18) * r.taoPriceUsd)} at ${usd(r.taoPriceUsd)} a TAO`,
    `Ratio: ${ratio.toFixed(2)}× the cost (a claim is due at ${p.claimMultiple}×, ${tao(p.claimMultiple * p.claimCostTao)})`,
    `Last claim (or deploy): ${at} UTC, ${dayCount(days)} ago`,
    `Decision: ${d.claim ? "claim" : "wait"}: ${d.reason}`,
    `A claim is sent with a ${limit.toLocaleString("en-US")} gas limit: ${tao(limit * r.gasPriceWei)} up front at the current gas price (unused gas is refunded); the wallet holds ${tao(r.walletWei)}`,
  ];
}
