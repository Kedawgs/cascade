import { formatUnits, parseUnits } from "viem";
import { floorRao, toDisplay } from "./cascade/units";
import { formatTao, formatUsd, formatUsdc, formatUsdShort } from "./format";

/** What the unstake amount is typed in: TAO, or its value in USDC. */
export type UnstakeUnit = "TAO" | "USDC";

/** TAO on buttons: at least 2 decimals, up to 4, so 0.005 stays 0.005. */
const taoLabel = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** What the stake and unstake buttons need to know to name themselves. */
export type StakeState = {
  account: string | null;
  amount: number | null;
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
    return `Unstake ${taoLabel.format(s.amount)} TAO`;
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
  return (Math.floor(toDisplay(taoWei, 18) * priceUsd * 100) / 100).toFixed(2);
}
