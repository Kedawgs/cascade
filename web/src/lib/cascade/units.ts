import { formatUnits } from "viem";
import { MIN_UNSTAKE_WEI, SLIPPAGE_BPS } from "./config";

/** One rao in wei: Bittensor moves value in whole rao. */
export const RAO = 10n ** 9n;
/** csTAO has 24 decimals, TAO 18: an empty vault mints 1e6 share units per wei. */
const LAUNCH_SHARES_PER_WEI = 10n ** 6n;

export const floorRao = (wei: bigint) => (wei / RAO) * RAO;
export const ceilRao = (wei: bigint) => ((wei + RAO - 1n) / RAO) * RAO;

export const lessSlippage = (x: bigint, bps: bigint = SLIPPAGE_BPS) => (x * (10_000n - bps)) / 10_000n;

/** Shares an amount of TAO stands for, rounded down. */
export function sharesFor(taoWei: bigint, totalAssets: bigint, totalSupply: bigint): bigint {
  if (totalAssets === 0n || totalSupply === 0n) return taoWei * LAUNCH_SHARES_PER_WEI;
  return (taoWei * totalSupply) / totalAssets;
}

/** TAO a number of shares is worth now, rounded down. */
export function taoFor(shares: bigint, totalAssets: bigint, totalSupply: bigint): bigint {
  if (totalSupply === 0n) return 0n;
  return (shares * totalAssets) / totalSupply;
}

/** Room left under the front door's deposit cap (its own check in `depositFor`). */
export function capFree(f: { depositCap: bigint; netForwarded: bigint; openTotal: bigint }): bigint {
  const used = f.netForwarded + f.openTotal;
  return f.depositCap > used ? f.depositCap - used : 0n;
}

/** How much more the open batch takes: none once its list is full (someone already on it could still
 * add to their entry, but the form can't tell who) or its value is at the limit, which the owner may
 * have lowered below what it holds. */
export function batchFree(f: { maxBatchValue: bigint; openTotal: bigint; openDeposits: number; maxDeposits: number }): bigint {
  if (f.openDeposits >= f.maxDeposits) return 0n;
  return f.maxBatchValue > f.openTotal ? f.maxBatchValue - f.openTotal : 0n;
}

/** Why an unstake can't go, so the form can say it in the unit it shows. */
export type UnstakeRefusal = "empty" | "tooMuch" | "stakeBelowMin" | "belowMin" | "leavesDust";

export type UnstakeCheck = { ok: true; all: boolean } | { ok: false; code: UnstakeRefusal; reason: string; offerAll: boolean };

/** "0.011 TAO" */
export const MIN_UNSTAKE_TEXT = `${formatUnits(MIN_UNSTAKE_WEI, 18)} TAO`;

/** The vault defers a front-door redeem worth less than 0.01 TAO (its payout could fall below the
 * bridge's floor after its fee), so an unstake is at least MIN_UNSTAKE_WEI and never leaves a smaller
 * remainder behind (it couldn't be unstaked later). */
export function checkUnstake(requestWei: bigint, availableWei: bigint): UnstakeCheck {
  const canAll = availableWei >= MIN_UNSTAKE_WEI;
  if (requestWei <= 0n) return { ok: false, code: "empty", reason: "Enter an amount", offerAll: false };
  if (requestWei > availableWei) return { ok: false, code: "tooMuch", reason: "That's more than you can unstake", offerAll: canAll };
  if (!canAll) return { ok: false, code: "stakeBelowMin", reason: `Unstakes start at ${MIN_UNSTAKE_TEXT}; your stake is below that`, offerAll: false };
  if (requestWei === availableWei) return { ok: true, all: true };
  if (requestWei < MIN_UNSTAKE_WEI) return { ok: false, code: "belowMin", reason: `Unstake at least ${MIN_UNSTAKE_TEXT}`, offerAll: false };
  const rest = availableWei - requestWei;
  if (rest < MIN_UNSTAKE_WEI) {
    return { ok: false, code: "leavesDust", reason: `That would leave less than ${MIN_UNSTAKE_TEXT}, too little to unstake later`, offerAll: true };
  }
  return { ok: true, all: false };
}

/** An exact amount as a number for display only. */
export function toDisplay(x: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(x / scale) + Number(x % scale) / Number(scale);
}
