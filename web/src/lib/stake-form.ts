import { formatUnits, parseUnits } from "viem";
import { DELIVERY_TOLERANCE_BPS, MIN_UNSTAKE_WEI } from "./cascade/config";
import type { DepositQuote, RoundTripCosts, WithdrawalQuote, WithdrawalRecord } from "./cascade/types";
import { isDelivering, offersClaim } from "./cascade/trail";
import { floorRao, toDisplay, type UnstakeCheck } from "./cascade/units";
import { formatTao, formatUsd, formatUsdc, formatUsdShort } from "./format";

/** What the unstake amount is typed in: TAO, or its value in USDC. */
export type UnstakeUnit = "TAO" | "USDC";

/** TAO on buttons: at least 2 decimals, up to 6 (the most the field takes), so 0.005 stays 0.005. */
const taoLabel = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** Floors to `decimals` places; the tiny nudge keeps 0.29 * 1e6 from flooring to 289999. */
const floorTo = (n: number, decimals: number) => Math.floor(n * 10 ** decimals + 1e-7) / 10 ** decimals;

/** What the stake and unstake buttons need to know to name themselves. */
export type StakeState = {
  account: string | null;
  amount: number | null;
  /** An unstake typed as a USDC value: the button names the dollars. */
  usd?: number;
  /** v3: the stake button names the amount in dollars ("Stake $20"). */
  dollars?: boolean;
  error: string | null;
  pending: boolean;
};

export function validateStakeAmount(
  amount: number | null,
  limits: { minUsd: number; maxUsd: number },
  /** The wallet's USDC balance when known; null skips the check. */
  balance: number | null = null,
): string | null {
  if (amount === null) return null;
  if (amount < limits.minUsd) return `The smallest stake is ${formatUsdShort(limits.minUsd)}.`;
  if (amount > limits.maxUsd) {
    return `The most you can stake right now is ${formatUsdShort(limits.maxUsd)}.`;
  }
  if (balance !== null && amount > balance + 1e-9) {
    return `You have ${formatUsdc(balance)} USDC on Base.`;
  }
  return null;
}

/** What MAX types into the USDC field: the balance floored to whole cents, never more than it holds. */
export function maxStakeInput(balance: number): string {
  return (Math.floor(balance * 100) / 100).toFixed(2);
}

export function stakeButtonLabel(s: StakeState): string {
  if (!s.account) return "Connect wallet";
  if (s.pending) return "Confirm in your wallet…";
  if (s.amount !== null && s.amount > 0 && s.error === null) {
    return s.dollars ? `Stake ${formatUsdShort(s.amount)}` : `Stake ${formatUsdc(s.amount)} USDC`;
  }
  return "Stake";
}

/** v3: Cascade's fees on a stake, "$0.05 + 0.15%": the flat fee, and the percentage read back from the
 * quote (the chain floors the swap fee, so it is rounded to hundredths of a percent). */
export function cascadeFeesText(q: Pick<DepositQuote, "usdcIn" | "depositFeeUsdc" | "swapFeeUsdc">): string {
  const parts: string[] = [];
  if (q.depositFeeUsdc > 0n) parts.push(formatUsdShort(toDisplay(q.depositFeeUsdc, 6)));
  const rate = swapFeeRate(q);
  if (rate > 0) parts.push(`${Number((rate * 100).toFixed(2))}%`);
  return parts.length > 0 ? parts.join(" + ") : "None";
}

/** Cascade's percentage fee as a fraction of what it is taken from (the USDC after the flat fee). */
function swapFeeRate(q: Pick<DepositQuote, "usdcIn" | "depositFeeUsdc" | "swapFeeUsdc">): number {
  const base = q.usdcIn - q.depositFeeUsdc;
  return base > 0n ? toDisplay(q.swapFeeUsdc, 6) / toDisplay(base, 6) : 0;
}

/** The pools' fees on the way in (and out): USDC –0.05%→ WETH –0.3%→ TAO. */
export const POOL_FEES_TEXT = "about 0.35%";
const EXIT_POOL_FEE = 0.0035;

/** v3: about how many days of yield pay for a round trip: this stake's Cascade and pool fees, plus an
 * estimated way out (Cascade's percentage fee and the pools' again on what was staked, the unstake
 * request fee and the bridge fee back), earned on what was staked at the yield less Cascade's cut
 * of rewards. Null without an amount or a yield. */
export function breakEvenDays(
  q: Pick<DepositQuote, "usdcIn" | "amountUsd" | "feesUsd" | "depositFeeUsdc" | "swapFeeUsdc">,
  exit: RoundTripCosts,
  yieldPct: number,
): number | null {
  const staked = Math.max(0, q.amountUsd - q.feesUsd);
  const perDay = (staked * yieldPct * (1 - exit.rewardCutBps / 10_000)) / 100 / 365;
  if (!(perDay > 0)) return null;
  const out = staked * (swapFeeRate(q) + EXIT_POOL_FEE) + exit.exitFixedUsd;
  return Math.max(1, Math.round((q.feesUsd + out) / perDay));
}

/** "You will stake": on v3 the quote's estimate and the least the stake accepts (its 0.5% floor,
 * rounded down to the 0.0001 TAO shown); on v2 the exact amount the swap buys. */
export function stakeAmountText(q: Pick<DepositQuote, "estTao" | "minTaoOut">, v3: boolean): string {
  if (!v3) return `${formatTao(q.estTao, 4)} TAO`;
  const least = Number(q.minTaoOut / 10n ** 14n) / 1e4;
  return `about ${formatTao(q.estTao, 4)} TAO (at least ${formatTao(least, 4)} TAO)`;
}

export function breakEvenText(days: number): string {
  return `Covers its fees in about ${days} day${days === 1 ? "" : "s"} at today's yield.`;
}

/** v3: the least USDC an unstake's automatic delivery pays, as the line under the button says it: the
 * TAO that comes back at the minimum price, floored to the cent. The bridge fee is only known when the
 * payout is sent, so today's is padded by a quarter; this is the figure shown, not the one sent. */
export function deliveryFloorUsd(q: Pick<WithdrawalQuote, "taoWei" | "bridgeFeeWei" | "minUsdcPerTao">): number {
  const bridgeFee = (q.bridgeFeeWei * 5n) / 4n;
  const tao = q.taoWei > bridgeFee ? q.taoWei - bridgeFee : 0n;
  const units = (tao * q.minUsdcPerTao) / 10n ** 18n;
  return toDisplay((units / 10_000n) * 10_000n, 6);
}

/** v3: the line under the unstake button; the floor once a quote has named it. */
export function deliveryNote(floorUsd: number | null): string {
  if (floorUsd === null) return "USDC arrives in your wallet automatically.";
  return `USDC arrives in your wallet automatically, at least ${formatUsd(floorUsd)} (today's price less ${DELIVERY_TOLERANCE_BPS / 100}%). If the price falls further, you can claim by hand.`;
}

/** Whether the Stake page offers "Claim as USDC" for what is waiting on Base: whenever something is,
 * except on v3 while an unstake's USDC is being delivered automatically (delivery sells everything
 * waiting at once) and no unstake offers the claim by hand. While the unstakes load that isn't known,
 * so v3 waits; if they can't be read it offers the claim, which needs only Base. */
export function offerClaim(
  claimable: bigint,
  v3: boolean,
  withdrawals: readonly WithdrawalRecord[] | undefined,
  unreadable = false,
): boolean {
  if (claimable === 0n) return false;
  if (!v3) return true;
  if (!withdrawals) return unreadable;
  if (withdrawals.some(offersClaim)) return true;
  return !withdrawals.some(isDelivering);
}

/** What MAX types into the TAO field: the exact available amount, floored to six decimals. */
export function maxUnstakeInput(taoWei: bigint): string {
  const floored = (taoWei / 10n ** 12n) * 10n ** 12n;
  return formatUnits(floored, 18);
}

export function unstakeButtonLabel(s: StakeState): string {
  if (!s.account) return "Connect wallet";
  if (s.pending) return "Confirm in your wallet…";
  if (s.amount !== null && s.amount > 0 && s.error === null) {
    return s.usd !== undefined ? `Unstake ${formatUsd(s.usd)}` : `Unstake ${taoLabel.format(floorTo(s.amount, 6))} TAO`;
  }
  return "Unstake";
}

/** The TAO (wei) an unstake asks for: typed in TAO, or a USDC value converted at `priceUsd` and
 * floored to whole rao. Null for nothing, zero or unreadable input. */
export function unstakeRequestWei(raw: string, unit: UnstakeUnit, priceUsd: number): bigint | null {
  if (raw.trim() === "") return null;
  try {
    if (unit === "TAO") {
      const wei = parseUnits(raw, 18);
      return wei > 0n ? wei : null;
    }
    if (!(priceUsd > 0)) return null;
    const usd = parseUnits(raw, 6);
    if (usd <= 0n) return null;
    const wei = floorRao((usd * 10n ** 18n) / BigInt(Math.round(priceUsd * 1e6)));
    return wei > 0n ? wei : null;
  } catch {
    return null;
  }
}

/** The amount in the other unit, shown under the field: "≈ $1.26" or "≈ 0.0396 TAO". */
export function unstakeEquivalent(taoWei: bigint, typedIn: UnstakeUnit, priceUsd: number): string {
  const tao = toDisplay(taoWei, 18);
  return typedIn === "TAO" ? `≈ ${formatUsd(tao * priceUsd)}` : `≈ ${formatTao(tao, 4)} TAO`;
}

/** What MAX types in the unit shown: exact TAO (six decimals), or its USDC value floored to cents. */
export function maxUnstakeInputIn(taoWei: bigint, unit: UnstakeUnit, priceUsd: number): string {
  if (unit === "TAO") return maxUnstakeInput(taoWei);
  return floorTo(toDisplay(taoWei, 18) * priceUsd, 2).toFixed(2);
}

/** Switching the unit shows the same request in the other unit and pins its exact TAO, so a
 * round trip through cents never changes what is sent. */
export function switchUnstakeUnit(
  request: bigint | null,
  unit: UnstakeUnit,
  priceUsd: number,
): { unit: UnstakeUnit; raw: string; pinned: bigint | null } {
  const next: UnstakeUnit = unit === "TAO" ? "USDC" : "TAO";
  return { unit: next, raw: request === null ? "" : maxUnstakeInputIn(request, next, priceUsd), pinned: request };
}

/** The dollars an unstake typed in USDC names on its button. A fixed amount (carried over by a unit
 * switch, or MAX) sends exact TAO, so its dollars follow the current price; otherwise they are the
 * dollars typed. Undefined when the button should name TAO. */
export function unstakeLabelUsd(s: {
  unit: UnstakeUnit;
  raw: string;
  fixed: boolean;
  requestWei: bigint | null;
  priceUsd: number;
}): number | undefined {
  if (s.unit !== "USDC" || s.requestWei === null) return undefined;
  if (s.fixed) return s.priceUsd > 0 ? floorTo(toDisplay(s.requestWei, 18) * s.priceUsd, 2) : undefined;
  const typed = Number(s.raw);
  return Number.isFinite(typed) && typed > 0 ? typed : undefined;
}

/** Dollars, floored to cents: what can be unstaked never reads higher than it is. */
const usdDown = (taoWei: bigint, priceUsd: number) => formatUsd(floorTo(toDisplay(taoWei, 18) * priceUsd, 2));
/** The minimum in dollars, rounded up to the cent so typing the figure shown is always enough. */
const MIN_USD = (priceUsd: number) => `about ${formatUsd(Math.ceil(toDisplay(MIN_UNSTAKE_WEI, 18) * priceUsd * 100 - 1e-7) / 100)}`;

/** The line under the unstake field: how much can go and the minimum, in the unit shown. */
export function unstakeNote(availableWei: bigint, unit: UnstakeUnit, priceUsd: number): string {
  if (unit === "USDC" && priceUsd > 0) {
    return `You can unstake up to ${usdDown(availableWei, priceUsd)}. The minimum is ${MIN_USD(priceUsd)} (0.005 TAO).`;
  }
  return `You can unstake up to ${maxUnstakeInput(availableWei)} TAO. The minimum is 0.005 TAO.`;
}

/** Why an amount can't be unstaked, in dollars when the user types dollars. */
export function unstakeErrorText(check: Extract<UnstakeCheck, { ok: false }>, availableWei: bigint, unit: UnstakeUnit, priceUsd: number): string {
  if (unit !== "USDC" || !(priceUsd > 0)) return check.reason;
  switch (check.code) {
    case "tooMuch":
      return `That's more than you can unstake (up to ${usdDown(availableWei, priceUsd)}).`;
    case "belowMin":
      return `The minimum unstake is ${MIN_USD(priceUsd)} (0.005 TAO).`;
    case "leavesDust":
      return `That would leave less than ${MIN_USD(priceUsd)} staked, too little to unstake later.`;
    case "stakeBelowMin":
      return `Your stake is below the minimum unstake of ${MIN_USD(priceUsd)} (0.005 TAO).`;
    default:
      return check.reason;
  }
}
