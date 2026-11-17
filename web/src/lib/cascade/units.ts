import { formatUnits } from "viem";
import { SLIPPAGE_BPS } from "./config";

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

/** v3.2 (R9, M-2): whether the open batch can close because a limit is reached, not by time: its deposit list at half its
 * limit (build B's list half rule, 2 x openDeposits >= maxDeposits: 25 of 50), or, holding deposits, the half rule as
 * CascadeFrontDoor.canClose judges it (at least half of maxBatchValue, no minimum deposit fitting under it, at least half
 * the room left under the cap, or no minimum deposit fitting under the cap). The keeper sends such a batch on its next
 * round, whatever its fees (ops due.ts closesWithoutFees, v32/reads.ts doorLimitsFull). The redeem list's own limit (at
 * full) isn't read here (getLimits' front door read has no maxRedeems): a batch closable by it alone reads as due by
 * time. The list still refuses a new depositor only once it is full (batchFree, BatchFull). */
export function depositLimitsReached(f: { openTotal: bigint; openDeposits: number; maxDeposits: number; maxBatchValue: bigint; minDeposit: bigint; depositCap: bigint; netForwarded: bigint }): boolean {
  if (2 * f.openDeposits >= f.maxDeposits) return true;
  const t = f.openTotal;
  if (t === 0n) return false;
  return 2n * t >= f.maxBatchValue || t + f.minDeposit > f.maxBatchValue || f.netForwarded + 2n * t >= f.depositCap || f.netForwarded + t + f.minDeposit > f.depositCap;
}

/** v3.2 (R12c): the minValue of the close the site sends before a stake ("Send the batch, then stake": flows.ts
 * planCloseFirst), from the open batch's own read at the click (its lists, its deposits and the door's limits, in one
 * block): built from the keeper's fullCloseFloor lines (ops v32/reads.ts), so a holder's cancel of a rao from an aged
 * entry between the read and the close (a partial cancel moves no clock) no longer voids it (BatchTooSmall). Each clause
 * of CascadeFrontDoor.canClose that held at the read gives a line. Its redeem list at its limit: 0, as the count makes it
 * full whatever the deposits. Its deposit list at half maxDeposits (build B): R12d, the keeper's list floor, the least the
 * entries the list needs can hold, ceil(maxDeposits / 2) x minDeposit (each entry holds at least a minimum deposit: a
 * part-cancel can't leave less), so a mass cancel of whole entries can't turn the user's paid close into a tiny batch.
 * Full by value (at least half of maxBatchValue, no minimum deposit fitting under it, at least half the room left under
 * depositCap, or no minimum deposit fitting under that): the least total at which that clause still holds. Each deposit
 * line at least 1 wei and never above the total. R12e: the HIGHEST of the lines that held, where the keeper's close names
 * the least: this close is the user's, paid for by them, so it lands only while the batch is still full by every line that
 * held at the read, never shrunk below the line it was shown full by (25+ depositors and half its value: 5 TAO of 10,
 * never the list's 1 TAO). A batch shrunk below it reverts BatchTooSmall instead, only Base's network fee spent, and the
 * stake reads its room again (a shrunk batch may take it, and then needs no close; else the user tries once more), at the
 * cost of that one retry. Unlike the keeper's, not 0 before the batch's interval: a wallet prompt may sit for minutes, and
 * a close that lands past the interval is canClose()'s by time, so the door no longer guards the line itself. Undefined
 * when no limit is reached (due by time alone): the close names the exact total. Every value clause grows with the total,
 * so none that didn't hold at the read holds below it. */
export function closeFirstFloor(
  b: { deposits: number; redeems: number; totalDeposits: bigint },
  l: { maxDeposits: number; maxRedeems: number; maxBatchValue: bigint; minDeposit: bigint; depositCap: bigint; netForwarded: bigint },
): bigint | undefined {
  const t = b.totalDeposits;
  const floors: bigint[] = [];
  if (b.redeems >= l.maxRedeems) floors.push(0n);
  if (t > 0n) {
    const half = (x: bigint) => (x <= 0n ? 0n : (x + 1n) / 2n);
    const capRoom = l.depositCap - l.netForwarded;
    const lines: bigint[] = [];
    // R12d: the deposit list at half its limit: ceil(maxDeposits / 2) entries of at least a minimum deposit each
    if (2 * b.deposits >= l.maxDeposits) lines.push(BigInt(Math.ceil(l.maxDeposits / 2)) * l.minDeposit);
    if (2n * t >= l.maxBatchValue) lines.push(half(l.maxBatchValue));
    if (t + l.minDeposit > l.maxBatchValue) lines.push(l.maxBatchValue - l.minDeposit + 1n);
    if (l.netForwarded + 2n * t >= l.depositCap) lines.push(half(capRoom));
    if (l.netForwarded + t + l.minDeposit > l.depositCap) lines.push(capRoom - l.minDeposit + 1n);
    for (const x of lines) floors.push(x < 1n ? 1n : x > t ? t : x);
  }
  if (floors.length === 0) return undefined;
  return floors.reduce((a, x) => (x > a ? x : a));
}

/** Why an unstake can't go, so the form can say it in the unit it shows. */
export type UnstakeRefusal = "empty" | "tooMuch" | "stakeBelowMin" | "belowMin" | "leavesDust" | "overEntry" | "entryFull";

export type UnstakeCheck = { ok: true; all: boolean } | { ok: false; code: UnstakeRefusal; reason: string; offerAll: boolean };

/** The unstake minimum in words: "0.033 TAO" on v3.2, "0.011 TAO" on v3-launch (config.minUnstakeWei). */
export const minUnstakeText = (minWei: bigint): string => `${formatUnits(minWei, 18)} TAO`;

/** 1e-6 TAO in wei: the finest step the unstake form shows. */
const MICRO_TAO = 10n ** 12n;

/** The most TAO one more unstake request can carry: the vault's maxEntryValue (it burns no more of one
 * request per delivery, and the rest stays staked, to be asked for again with a new fee), less 1% for the
 * share price rising before delivery, less what this account's request in the open batch already asks
 * (the front door adds a second request in the same batch to the first). Floored to 0.000001 TAO. */
export function unstakeMostWei(maxEntryValue: bigint, askedWei: bigint): bigint {
  const room = (maxEntryValue * 99n) / 100n - askedWei;
  return room > 0n ? (room / MICRO_TAO) * MICRO_TAO : 0n;
}

/** What follows the per-unstake limit: the vault's daily outflow limit is shared, so the rest waits a day. */
export const REST_LATER = "unstake the rest a day later (unstakes are limited per day)";
/** The open batch's request from this account already carries as much as one can. */
export const ENTRY_FULL_TEXT = "Your unstake in the current batch is already as large as one can be; unstake more after it leaves";
/** No amount can go in one more request: under a limit (`mostWei`) whose room is below the minimum unstake
 * (`minWei`, the deployment's: config.minUnstakeWei, always given, so no caller gets another deployment's minimum
 * by leaving it out), and a stake larger than that room (else all of it fits). */
export const entryFull = (availableWei: bigint, mostWei: bigint | undefined, minWei: bigint): boolean =>
  mostWei !== undefined && mostWei < minWei && availableWei > mostWei;

/** The vault defers a front-door redeem worth less than its minimum (v3-launch's 0.01 TAO, v3.2's 0.03 TAO: its
 * payout could fall below the bridge's floor after its fee), so an unstake is at least the deployment's minimum
 * (`minWei`, config.minUnstakeWei, 10% above the vault's; always given) and never leaves a smaller
 * remainder behind (it couldn't be unstaked later): below twice the minimum, only all of it goes. With `mostWei`
 * (unstakeMostWei), no request is larger than one unstake can carry, and all of a stake above it is never
 * offered. */
export function checkUnstake(requestWei: bigint, availableWei: bigint, mostWei: bigint | undefined, minWei: bigint): UnstakeCheck {
  const min = minUnstakeText(minWei);
  const canAll = availableWei >= minWei;
  const allFits = mostWei === undefined || availableWei <= mostWei;
  // first, whatever is typed: no amount can go until the open batch leaves
  if (canAll && entryFull(availableWei, mostWei, minWei)) return { ok: false, code: "entryFull", reason: ENTRY_FULL_TEXT, offerAll: false };
  if (requestWei <= 0n) return { ok: false, code: "empty", reason: "Enter an amount", offerAll: false };
  if (requestWei > availableWei) return { ok: false, code: "tooMuch", reason: "That's more than you can unstake", offerAll: canAll && allFits };
  if (!canAll) return { ok: false, code: "stakeBelowMin", reason: `Unstakes start at ${min}; your stake is below that`, offerAll: false };
  if (mostWei !== undefined && requestWei > mostWei) {
    return { ok: false, code: "overEntry", reason: `One unstake can carry up to ${formatUnits(mostWei, 18)} TAO; ${REST_LATER}`, offerAll: false };
  }
  if (requestWei === availableWei) return { ok: true, all: true };
  if (requestWei < minWei) return { ok: false, code: "belowMin", reason: `Unstake at least ${min}`, offerAll: false };
  const rest = availableWei - requestWei;
  if (rest < minWei) {
    return { ok: false, code: "leavesDust", reason: `That would leave less than ${min}, too little to unstake later`, offerAll: allFits };
  }
  return { ok: true, all: false };
}

/** v3.2's note on an unstake forced to be all of a small stake (spec §3.3, L-H). The vault defers a redeem on its
 * value in TAO at the batch's price (CascadeBatchLib.sol:157-162), which TAO's dollar price doesn't move: what can
 * fall before delivery is the share's TAO value (Task 58 review, Minor 5; the controller's wording). */
export const PRICE_DROP_NOTE = "A remainder near the minimum can fall just below it before delivery; that part then waits and you request it again.";

/** The note an unstake carries when "all" is forced on it: the stake is under twice the minimum (`minWei`), so all
 * of it is the only unstake it can make, and a check that goes as all, or offers all, is near the minimum; by
 * delivery its value in TAO can fall under the vault's minimum, and the vault then defers it (RedeemDeferred:
 * nothing burned) until it is requested again. Null for any other check, or none. */
export function priceDropNote(check: UnstakeCheck | null, availableWei: bigint, minWei: bigint): string | null {
  if (!check || !(check.ok ? check.all : check.offerAll)) return null;
  return availableWei >= minWei && availableWei < 2n * minWei ? PRICE_DROP_NOTE : null;
}

/** An exact amount as a number for display only. */
export function toDisplay(x: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  return Number(x / scale) + Number(x % scale) / Number(scale);
}
