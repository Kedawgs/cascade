import { formatTao, formatUsdc, formatUsdShort } from "./format";

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
  if (s.pending) return "Starting your stake…";
  if (s.amount !== null && s.amount > 0 && s.error === null) return `Stake ${formatUsdc(s.amount)} USDC`;
  return "Stake";
}

export function validateUnstakeAmount(amount: number | null, balance: number): string | null {
  if (amount === null) return null;
  if (amount === 0) return "Enter how much TAO to unstake.";
  if (amount > balance + 1e-9) return `You have ${formatTao(balance, 2)} TAO staked.`;
  return null;
}

export function unstakeButtonLabel(s: StakeState): string {
  if (!s.account) return "Connect wallet";
  if (s.pending) return "Starting your unstake…";
  if (s.amount !== null && s.amount > 0 && s.error === null) {
    return `Unstake ${formatTao(s.amount, 2)} TAO`;
  }
  return "Unstake";
}
