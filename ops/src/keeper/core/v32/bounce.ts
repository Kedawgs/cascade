// What the vault will do with a batch's deposits when it arrives (spec §3.1, Task 10c; CascadeVault.onBridgeMessage):
// mint, bounce them back (below half the launch price, which with shares outstanding an underwater vault always is),
// or, at a supply of 0 while underwater, refuse the whole batch so the Bittensor adapter parks it. The keeper says so
// before it closes a batch with deposits (it closes all the same: a bounce is paid back, a park refunded or delivered
// by the park job, Task 52). Pinned to the contracts by test/keeper-v32.test.ts.

/** CascadeConstants.UNDERWATER_TOLERANCE: 1,000 rao, in wei. */
export const UNDERWATER_TOLERANCE_WEI = 1_000n * 10n ** 9n;
/** CascadeVault's half-launch-price line: deposits bounce while totalAssets × 2,000,000 < totalSupply. */
export const HALF_LAUNCH_SHARES_PER_WEI = 2_000_000n;

const sub0 = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

/** CascadeFormulas.underwater: with rewards vesting, while they are more than the gross holds beyond the queued
 * payouts; with none, while the queued payouts exceed the gross by more than the tolerance. */
export function underwater(gross: bigint, pendingPayouts: bigint, unvested: bigint): boolean {
  if (unvested !== 0n) return unvested > sub0(gross, pendingPayouts);
  return sub0(pendingPayouts, gross) > UNDERWATER_TOLERANCE_WEI;
}

export interface VaultSolvency {
  grossAssets: bigint;
  pendingPayouts: bigint;
  unvestedRewards: bigint;
  totalAssets: bigint;
  totalSupply: bigint;
}

/** "mint", "bounce" (the deposits come back, each paying its share of the payout chunk's fee) or "park" (the batch is
 * refused whole and parked by the adapter). At a supply of 0 the vault first writes the schedule down to what the gross
 * holds beyond the payouts (_unvestedForMint), so only the payouts count there. */
export function depositOutlook(v: VaultSolvency): "mint" | "bounce" | "park" {
  if (v.totalSupply === 0n) {
    const unvested = v.unvestedRewards < sub0(v.grossAssets, v.pendingPayouts) ? v.unvestedRewards : sub0(v.grossAssets, v.pendingPayouts);
    return underwater(v.grossAssets, v.pendingPayouts, unvested) ? "park" : "mint";
  }
  return v.totalAssets * HALF_LAUNCH_SHARES_PER_WEI < v.totalSupply ? "bounce" : "mint";
}

/** The line the keeper logs before closing a batch with deposits the vault won't mint for, or undefined. */
export function outlookLine(outlook: ReturnType<typeof depositOutlook>, nDeposits: number): string | undefined {
  if (nDeposits === 0 || outlook === "mint") return undefined;
  return outlook === "bounce"
    ? `The vault is below half its launch price, or underwater: this batch's ${nDeposits} deposit${nDeposits === 1 ? "" : "s"} will come back to Base, each less its share of the payout's fee`
    : `The vault is underwater with no shares: it will refuse this batch, and the bridge adapter will hold it until it can be delivered or refunded`;
}
