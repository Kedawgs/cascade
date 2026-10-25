import { formatUnits, parseUnits } from "viem";
import { floorRao, toDisplay } from "./cascade/units";
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
  if (s.amount !== null && s.amount > 0 && s.error === null) return `Stake ${formatUsdc(s.amount)} USDC`;
  return "Stake";
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

/** What can be unstaked, floored the way MAX fills it: "0.090086 TAO ($22.73)". */
export function unstakeAvailableText(taoWei: bigint, priceUsd: number): string {
  const tao = `${maxUnstakeInput(taoWei)} TAO`;
  return priceUsd > 0 ? `${tao} (${formatUsd(floorTo(toDisplay(taoWei, 18) * priceUsd, 2))})` : tao;
}
