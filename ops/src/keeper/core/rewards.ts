import { type Address, formatEther, type Hex, parseAbi } from "viem";
import { BITTENSOR_TX_GAS_CEILING, underCeiling } from "./ceiling.ts";
import type { CallRequest } from "./types.ts";

const DAY = 86_400;
const MONTH = 30 * DAY;

const tao = (wei: bigint) => `τ${formatEther(wei)}`;
const usd = (x: number) => `$${x.toFixed(2)}`;
const dayCount = (n: number) => (n === 1 ? "1 day" : `${n} days`);

/** When a reward claim is worth its cost (spec, keeper and reward policy): when what is waiting is at
 * least `claimMultiple` times the cost, or monthly while one claim costs under `monthlyClaimMaxUsd`. */
export interface ClaimPolicy {
  /** One claim's cost, in TAO wei. */
  claimCostTao: bigint;
  claimMultiple: bigint;
  monthlyClaimMaxUsd: number;
}

export interface ClaimInput {
  waitingWei: bigint;
  costWei: bigint;
  taoPriceUsd: number;
  lastClaimAt: number;
  now: number;
  multiple: bigint;
  monthlyMaxUsd: number;
}

/** The claim policy's longest gap between claims (R4, the vault-favour review's Medium 1): a small vault's monthly claim,
 * 30 days after the last. */
export const CLAIM_GAP_MAX_S = MONTH;

/** Why the vault's rewardVesting (seconds) is too short for the claim policy, or undefined: rewards vesting faster than
 * the keeper claims them let a holder present only while they vest take more than its time share of a claim's yield. */
export function vestingGapProblem(rewardVestingS: bigint): string | undefined {
  if (rewardVestingS >= BigInt(CLAIM_GAP_MAX_S)) return undefined;
  const days = (s: bigint | number) => `${Number(s) / DAY} day${Number(s) === DAY ? "" : "s"}`;
  return `the vault's rewardVesting is ${days(rewardVestingS)}, shorter than the claim policy's longest gap between claims (${days(CLAIM_GAP_MAX_S)}): a holder present only while rewards vest takes more than its share of them. Raise it to at least ${days(CLAIM_GAP_MAX_S)} (setRewardVesting: a raise is immediate)`;
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
/** CascadeVault's claimGasRequired until the owner changes it. */
export const VAULT_CLAIM_GAS_REQUIRED = 55_000_000n;
/** The most claimGasRequired can ever be on v3.2 (CascadeConstants.MAX_CLAIM_GAS, 63,400,000 since the Task 65 review: the
 * vault refuses a setting above it), so claimGasLimit(CLAIM_GAS_REQUIRED_MAX), the ceiling, is the largest gas limit a
 * keeper claim is ever sent with. */
export const CLAIM_GAS_REQUIRED_MAX = 63_400_000n;
/** The claim's own work outside the forwarded claimRootWithHotkey (the intrinsic gas, the vault's checks, eight getStake
 * reads with four hotkeys listed, the booking, the treasury's cut, the events), as the contracts allow it beside
 * MAX_CLAIM_GAS: 500,000, twice the 218,947 Task 65 measured at its dearest (CascadeConstants.sol, VaultClaimGas.t.sol). */
export const CLAIM_OVERHEAD_ALLOWANCE = 500_000n;
/** The claim is sent with a fixed gas limit: claimGasRequired plus the margin (55M + 2M at launch), held to Bittensor's
 * per-transaction ceiling (ceiling.ts; Task 65), so at the vault's top, 63.4M, it goes with 64.9M, 1.5M over the setting,
 * three times the claim's own work. The precompile refuses less than ~53.2M, and the vault checks claimGasRequired is
 * left before calling it. */
export const claimGasLimit = (claimGasRequired: bigint): bigint => underCeiling(claimGasRequired + CLAIM_GAS_MARGIN);

/** Why no transaction can carry a claim at the vault's `claimGasRequired`, or undefined: the setting and the claim's own
 * work (CLAIM_OVERHEAD_ALLOWANCE) need more than Bittensor's per-transaction ceiling (`ceiling`, BITTENSOR_TX_GAS_CEILING
 * by default), so a claim the vault lets start would run out of gas, or its limit would be refused by the pool. Under
 * MAX_CLAIM_GAS it never is: 63.4M + 0.5M is a million under the ceiling. */
export function claimCeilingProblem(claimGasRequired: bigint, ceiling: bigint = BITTENSOR_TX_GAS_CEILING): string | undefined {
  if (claimGasRequired + CLAIM_OVERHEAD_ALLOWANCE <= ceiling) return undefined;
  const n = (x: bigint) => x.toLocaleString("en-US");
  // the most it may be: what the ceiling holds, never above the vault's own top (R5 Minor 8)
  const fits = ceiling - CLAIM_OVERHEAD_ALLOWANCE;
  return `the vault's claimGasRequired (${n(claimGasRequired)}) and the claim's own work outside the precompile call (${n(CLAIM_OVERHEAD_ALLOWANCE)} allowed) need more than Bittensor's per-transaction gas ceiling (${n(ceiling)}): no transaction can carry the claim; the owner lowers claimGasRequired (setClaimGasRequired, at once) to at most ${n(fits < CLAIM_GAS_REQUIRED_MAX ? fits : CLAIM_GAS_REQUIRED_MAX)}`;
}

/** Bittensor takes the whole gas limit's fee up front and refunds what is unused: null when the wallet
 * can pay it, else why not. */
export function upfrontShortfall(r: RewardsRead): string | null {
  const limit = claimGasLimit(r.claimGasRequired);
  const need = limit * r.gasPriceWei;
  if (r.walletWei >= need) return null;
  return `a claim is sent with a ${limit.toLocaleString("en-US")} gas limit, so the wallet needs ${tao(need)} up front (unused gas is refunded); it holds ${tao(r.walletWei)}. Top it up on Bittensor; nothing sent`;
}

// ---- v3.2 (Task 51): a claim on every listed hotkey, and the adoption ----

/** One listed hotkey, as v3.2's claim job reads it: what waits on it (the claim source, abi.ts CLAIM_SOURCE, for the
 * vault's coldkey, in wei), its last claim (or its first listing), the vault's root stake on it (rao), and whether it
 * is the stake hotkey. */
export interface HotkeyRead {
  hotkey: Hex;
  waitingWei: bigint;
  lastClaimAt: number;
  stakeRao: bigint;
  stakeHotkey: boolean;
  /** R6b (U9): for a hotkey being freed, why its deferred rewards (which waitingWei leaves out) forbid its removal now:
   * owed above the dust allowance, or unread (v32/deferred.ts); undefined when they are clear, or not read */
  deferredProblem?: string;
}

/** v3.2's claim schedule, as the lens reads it (vestingStart, vestingPeriod, vestingAmount): what the last claim that booked
 * rewards set vesting, from when (s), over how long (s); all 0 before the first such claim (R6b, U1 and U2). */
export interface ClaimSchedule {
  start: number;
  period: number;
  amount: bigint;
}

/** What v3.2's claim decisions read: every listed hotkey, in the vault's order (the standby among them once it is
 * listed), the claim schedule, Bittensor's time, TAO's price on Base, and what a claim transaction needs up front. */
export interface ClaimsRead {
  hotkeys: HotkeyRead[];
  schedule: ClaimSchedule;
  now: number;
  /** USDC for 1 TAO along the staker's delivery route (NaN when it can't be priced: the monthly claim then waits) */
  taoPriceUsd: number;
  claimGasRequired: bigint;
  /** What a claim transaction would pay a gas at most now (its fee cap: on Bittensor's legacy transactions the gas price;
   * on an EIP-1559 chain twice it), as the journal counts a pending send's worst case */
  feeCapWei: bigint;
  /** The keeper's TAO on Bittensor */
  walletWei: bigint;
}

/** A hotkey being freed (spec §3.1): listed, not the stake hotkey, and holding none of the vault's stake: a validator
 * swap's old hotkey, or the old stake hotkey once the owner's setStakeHotkey and moves have emptied it, and also a standby
 * listed and not staked yet, which has nothing to claim (credits accrue only on stake), so is never called "being freed"
 * (T51 review M3). */
export const beingFreed = (h: HotkeyRead): boolean => !h.stakeHotkey && h.stakeRao === 0n;

/** R6b (U1, U2): the claim round comes this long before the claim schedule ends, and before any staked hotkey's last claim
 * is CLAIM_GAP_MAX_S old: 2 days, so a claim the spend cap puts off a day, or one tried again, still lands before the
 * schedule has vested (a stranger may claim only then, U1) and before a hotkey's backlog passes one period (U2). A
 * schedule of 4 days or less takes half its period instead (claimLead). */
export const CLAIM_LEAD_S = 2 * DAY;

/** R7 (L6): how long before the claim schedule ends its round comes: CLAIM_LEAD_S, or half the schedule's period when that
 * is no longer than twice the lead (the vault's rewardVesting may be as short as a day). At a lead as long as the period,
 * the round would come before the schedule's own start, so the claim that restarted it would never be followed by
 * another: no claim until a hotkey's 28-day backlog, against rewards vesting in a day or two (the keeper's readiness says
 * REWARDS VEST TOO FAST below 30 days either way). */
export const claimLead = (period: number): number => (period > 2 * CLAIM_LEAD_S ? CLAIM_LEAD_S : Math.floor(period / 2));

/** CascadeConstants.MAX_HOTKEYS: the most hotkeys the vault lists, so the most claims one round makes (v32/payout.ts keeps
 * the copy held to the contracts; a test holds this one to it, and rewards.ts can't import it from there: payout.ts
 * imports rewards.ts). */
const ROUND_CLAIMS_MAX = 4;

/** R6b, R7 (M2): a staked hotkey last claimed more than this before the claim schedule's last restart was left out of that
 * round, so it is claimed now (the round's other claims follow the one that restarted it). (MAX_HOTKEYS + 1) days, 5: a
 * round of MAX_HOTKEYS claims at one a day (a spend cap that fits one claim a day) spans MAX_HOTKEYS - 1 days, so once its
 * last claim restarts the schedule every claim of the round is within the slack, and the round ends (at 3 days, the
 * fourth claim's restart left the first behind, and the round chased itself, a claim a day for ever). It ends so as long
 * as its claims average under 5/3 days apart; a claim held longer (a repeat revert's back-off, a fee spike) can bring the
 * round's earlier claims back once more, at most MAX_HOTKEYS - 1 of them, and then it ends. A hotkey claimed within the
 * slack has at most 5 days of its rewards pushed onto the new schedule. */
export const CLAIM_ROUND_SLACK_S = (ROUND_CLAIMS_MAX + 1) * DAY;

const utc = (s: number) => `${new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
/** A span in words: "2 days", "1 day", "12 hours". */
const span = (s: number) => (s % DAY === 0 ? dayCount(s / DAY) : s % 3_600 === 0 ? `${s / 3_600} hours` : `${Math.round(s / 60)} minutes`);

/** A claim's cost in words: the policy's estimate, and in dollars at TAO's price when it is read. */
function costWords(costWei: bigint, taoPriceUsd: number): string {
  const dollars = (Number(costWei) / 1e18) * taoPriceUsd;
  return `${tao(costWei)} (${Number.isFinite(dollars) ? `${usd(dollars)} at ${usd(taoPriceUsd)} a TAO` : "TAO's price couldn't be read"})`;
}

/** Whether `h`'s rewards are due their claim (claimRewards(h)), and why. A hotkey being freed is claimed whenever credits
 * wait on it, whatever the policy says (preflight A17, over the plan's noClaimOnAHotkeyBeingFreed): its slot may be freed
 * only once they read 0, so it is claimed until they do, never freed with them on it, nor left listed for want of a claim
 * the policy would put off for good. Every other listed hotkey with credits waiting (the stake hotkey, the standby, any
 * staked) is claimed by one round (R6b, U1 and U2; Fable's second check of U1/U2): only the keeper may claim while the
 * claim schedule still vests, and a claim on one hotkey restarts the whole schedule, so every staked hotkey goes together:
 * - when at least claimMultiple times a claim's cost waits on it (the policy's early claim). Its claim restarts the
 *   schedule too, so it drags every other staked hotkey into the round with it: each is then claimed by the last rule,
 *   whatever its own claim costs;
 * - claimLead (CLAIM_LEAD_S, or half a short schedule) before the claim schedule ends (or once it has ended), unless
 *   claimed since then;
 * - once its own last claim is CLAIM_GAP_MAX_S less CLAIM_LEAD_S old, so no backlog passes one period;
 * - and once the claim schedule restarted more than CLAIM_ROUND_SLACK_S after its last claim (the round goes on).
 * In a round it is claimed whatever its claim costs, even more than waits on it (its line says the cost); the spend cap
 * and the wallet still bound it (claims.ts claimRoom). v3-launch's claimDecision is unchanged. */
export function claimFor(h: HotkeyRead, r: Pick<ClaimsRead, "now" | "taoPriceUsd" | "schedule">, p: ClaimPolicy): { claim: boolean; reason: string } {
  if (beingFreed(h)) {
    if (h.waitingWei === 0n) return { claim: false, reason: "listed, nothing staked yet (or emptied), and nothing waits on it: nothing to claim" };
    return {
      claim: true,
      reason: `it holds none of the vault's stake (a swap's old hotkey, or the old stake hotkey) and ${tao(h.waitingWei)} of credits wait on it: claimed until they read 0, whatever the claim policy, so its slot is never freed with them on it`,
    };
  }
  if (h.waitingWei === 0n) return { claim: false, reason: `${tao(0n)} is waiting: nothing to claim` };
  const cost = p.claimCostTao;
  const threshold = p.claimMultiple * cost;
  const waiting = tao(h.waitingWei);
  if (h.waitingWei >= threshold) return { claim: true, reason: `${waiting} is waiting, at least ${p.claimMultiple}× the ${tao(cost)} a claim costs (${tao(threshold)})` };
  const s = r.schedule;
  const end = s.start + s.period;
  const lead = claimLead(s.period);
  const cadenceAt = end - lead;
  const cadence = s.period > 0 && r.now >= cadenceAt && h.lastClaimAt < cadenceAt;
  const backlogAt = h.lastClaimAt + CLAIM_GAP_MAX_S - CLAIM_LEAD_S;
  const behind = s.period > 0 && h.lastClaimAt + CLAIM_ROUND_SLACK_S < s.start;
  const every = (CLAIM_GAP_MAX_S - CLAIM_LEAD_S) / DAY;
  const why = cadence
    ? `the claim schedule ${r.now >= end ? "ended" : "ends"} at ${utc(end)}, and every staked hotkey is claimed ${span(lead)} before it ends`
    : r.now >= backlogAt
      ? `its last claim was ${Math.floor((r.now - h.lastClaimAt) / DAY)} days ago, and every staked hotkey is claimed at least every ${every} days`
      : behind
        ? `the claim schedule restarted at ${utc(s.start)}, after this hotkey's last claim (${utc(h.lastClaimAt)}), so it is claimed in the same round`
        : undefined;
  if (!why) {
    const next = s.period > 0 && h.lastClaimAt < cadenceAt ? Math.min(cadenceAt, backlogAt) : backlogAt;
    return { claim: false, reason: `${waiting} is waiting, below ${p.claimMultiple}× the ${tao(cost)} a claim costs (${tao(threshold)}); the next claim round is at ${utc(next)}` };
  }
  const price = costWords(cost, r.taoPriceUsd);
  const pays = h.waitingWei > cost ? `a claim costs about ${price}, and ${waiting} is waiting` : `its claim costs about ${price}, more than the ${waiting} waiting, but it is claimed anyway`;
  return { claim: true, reason: `the claim round: ${why}; ${pays}` };
}

/** Whether the claim job is done with a hotkey being freed, so its slot may be freed: it is being freed and its
 * credits read 0 (A17). Until then it is claimed, never removed. The removal itself and its other conditions are Task
 * 53's: the hotkey must once have held the vault's stake (the swap's old hotkey, after the owner's setStakeHotkey), never
 * a standby listed and waiting for its stake, which this is true of too (T51 review M3). A hotkey a claim paid its
 * credits onto as stake holds stake, so is not being freed: its removal is the owner's (I-6). R6b (U9): nor while its
 * deferred rewards, which its credits leave out, are owed above the dust allowance or unread (deferredProblem). */
export const slotFreeable = (h: HotkeyRead): boolean => beingFreed(h) && h.waitingWei === 0n && h.deferredProblem === undefined;

/** CascadeVault's STAKE_RAMP (1 days), in seconds: adoptStake runs at most once per it, counted from lastAdoptAt (spec
 * §3.10.2; a test holds it to the vault's source). */
export const STAKE_RAMP_S = 86_400;

/** What the adoption reads, all from the chain: the surplus (the visible stake above the booked, rao) and the chain's
 * minimum stake (rao), the vault's pause and its stake missing, its last adoption (or its deploy) and Bittensor's time. */
export interface AdoptionRead {
  surplusRao: bigint;
  minStakeRao: bigint;
  paused: boolean;
  stakeMissing: boolean;
  lastAdoptAt: number;
  now: number;
}

const raoTao = (rao: bigint) => `${formatEther(rao * 10n ** 9n)} TAO`;

/** Whether the vault's surplus is due its adoption (adoptStake), and why (`surplus`: there is one worth saying, at least
 * the minimum): a surplus of at least the chain's minimum stake, the vault not paused (adoptStake refuses while it is),
 * no stake missing, and a STAKE_RAMP since the chain's lastAdoptAt by Bittensor's clock, never by the keeper's memory
 * (another caller's adoption counts, and a restart forgets nothing). */
export function adoptionDue(a: AdoptionRead): { adopt: boolean; reason: string; surplus: boolean } {
  const held = `the vault's listed hotkeys hold ${raoTao(a.surplusRao)} of stake above the booked stake (a gift, or stake back after a write-off)`;
  if (a.surplusRao < a.minStakeRao) return { adopt: false, surplus: false, reason: `no surplus of at least the chain's minimum stake (${raoTao(a.minStakeRao)})` };
  if (a.paused) return { adopt: false, surplus: true, reason: `${held}, but the vault is paused (adoptStake refuses while it is)` };
  if (a.stakeMissing) return { adopt: false, surplus: true, reason: `${held}, but some of the vault's stake is missing (nothing is adopted then)` };
  const next = a.lastAdoptAt + STAKE_RAMP_S;
  if (a.now < next) {
    return { adopt: false, surplus: true, reason: `${held}; the last adoption was at ${new Date(a.lastAdoptAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC, and the next may come a day (STAKE_RAMP) after it` };
  }
  return { adopt: true, surplus: true, reason: `${held}, at least the chain's minimum: adopted into the price, vested like a reward` };
}

/** A plan's steps, as vaultColdkey reads them (plan.ts Plan and PlanV3 are each one). */
export interface PlannedSteps {
  steps: readonly { id: string; args: readonly unknown[] }[];
}

/** The vault's own coldkey, from the plan (the vault's first constructor argument). */
export const vaultColdkey = (plan: PlannedSteps): Hex => plan.steps.find((s) => s.id === "vault")!.args[0] as Hex;

export const CLAIM_ABI = parseAbi(["function claimRewards(bytes32 hotkey)"]);

export const claimRequest = (rec: { plan: { addresses: { vault: Address } } }, hotkey: Hex, gasLimit: bigint, nonce: number): CallRequest => ({
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
