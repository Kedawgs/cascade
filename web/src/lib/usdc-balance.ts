import { formatUsdc } from "./format";

/** USDC on Base (6 decimals). */
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const USDC_DECIMALS = 6;

/** The shape the on-chain balance is reduced to for display. */
export type BalanceQuery = { status: "pending" | "error" | "success"; data?: number };

/** What the summary shows for "Available to stake", and what MAX fills in. */
export function availableToStake(q: BalanceQuery): { text: string; max: number | null } {
  if (q.status === "success" && q.data !== undefined) {
    return { text: `${formatUsdc(q.data)} USDC`, max: q.data };
  }
  return { text: "–", max: null };
}
