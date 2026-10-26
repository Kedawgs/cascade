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

/** Why an unstake can't go, so the form can say it in the unit it shows. */
export type UnstakeRefusal = "empty" | "tooMuch" | "stakeBelowMin" | "belowMin" | "leavesDust";

export type UnstakeCheck = { ok: true; all: boolean } | { ok: false; code: UnstakeRefusal; reason: string; offerAll: boolean };

const MIN_TEXT = "0.005 TAO";

/** Every payout must clear the bridge's 0.002-TAO floor after its fee, so an unstake is at least
 * 0.005 TAO and never leaves a smaller remainder behind (it could never be paid out). */
export function checkUnstake(requestWei: bigint, availableWei: bigint): UnstakeCheck {
  const canAll = availableWei >= MIN_UNSTAKE_WEI;
  if (requestWei <= 0n) return { ok: false, code: "empty", reason: "Enter an amount", offerAll: false };
  if (requestWei > availableWei) return { ok: false, code: "tooMuch", reason: "That's more than you can unstake", offerAll: canAll };
  if (!canAll) return { ok: false, code: "stakeBelowMin", reason: `Unstakes start at ${MIN_TEXT}; your stake is below that`, offerAll: false };
  if (requestWei === availableWei) return { ok: true, all: true };
  if (requestWei < MIN_UNSTAKE_WEI) return { ok: false, code: "belowMin", reason: `Unstake at least ${MIN_TEXT}`, offerAll: false };
  const rest = availableWei - requestWei;
  if (rest < MIN_UNSTAKE_WEI) {
    return { ok: false, code: "leavesDust", reason: `That would leave less than ${MIN_TEXT}, too little to unstake later`, offerAll: true };
  }
  return { ok: true, all: false };
}

/** An exact amount as a number for display only. */
export function toDisplay(x: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(x / scale) + Number(x % scale) / Number(scale);
}
