/** The activity records the screens show. Shared by the trail builder and the data contract. */

export type StepStatus = "done" | "active" | "pending" | "failed" | "action";
export type DepositStepKey = "swap" | "deposit" | "bridge" | "stake";
export type WithdrawalStepKey = "request" | "unstake" | "return" | "claim";

export interface TrailStep<K extends string = DepositStepKey | WithdrawalStepKey> {
  key: K;
  status: StepStatus;
  title: string;
  detail?: string;
  /** A few words for lists ("waiting for the 0.02 TAO minimum"); lists otherwise use the step's usual phrase. */
  summary?: string;
  txUrl?: string;
  /** Link text for `txUrl`. The UI falls back to "View transaction". */
  txLabel?: string;
  at?: Date;
}

export interface DepositRecord {
  id: string;
  createdAt: Date;
  sourceChain: "base";
  status: "in_progress" | "staked" | "failed" | "needs_you" | "cancelled";
  steps: TrailStep<DepositStepKey>[];
  /** TAO this deposit put in (exact, and as a display number). */
  taoWei: bigint;
  taoAmount: number;
  /** Known only for deposits made from this browser. */
  amountUsd?: number;
  feesUsd?: number;
  taoPriceUsd?: number;
  /** TAO still in the open batch that can be taken back. */
  cancellableWei?: bigint;
  /** Stopped before any transaction was sent, so it can simply be removed. */
  nothingSent?: true;
  /** The swap worked but the deposit failed: the deposit alone can be tried again. */
  retryable?: true;
  /** The swap itself failed: start a new stake at today's price. */
  restake?: true;
}

export interface WithdrawalRecord {
  id: string;
  createdAt: Date;
  status: "in_progress" | "ready" | "paid" | "failed" | "needs_you" | "cancelled";
  steps: TrailStep<WithdrawalStepKey>[];
  shares: bigint;
  taoAmount: number;
  /** An estimate until it's paid; absent when unknown. */
  usdcAmount?: number;
  feesUsd?: number;
  /** TAO waiting on Base for the user to claim. */
  claimable: bigint;
  /** What the claim actually paid, read from its receipts. */
  received?: { usdc?: number; keptTao?: number };
  /** Shares still in the open batch that can be taken back. */
  cancellableShares?: bigint;
  /** Nothing was taken when it arrived (balance too small, or the daily limit): unstake again. */
  unstakeAgain?: true;
}
