/** The activity records the screens show. Shared by the trail builder and the data contract. */

import type { Hex } from "viem";

/** "checking": whether this step happened can't be told yet (the chain hasn't confirmed what the history
 * indexer said about it): neither done nor not done, and shown as neither. */
export type StepStatus = "done" | "active" | "pending" | "failed" | "action" | "checking";
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
  /** TAO still in the open batch that can be taken back, and that batch's id (a cancel takes from the open batch, so
   * the click checks it is still this one). */
  cancellableWei?: bigint;
  cancelBatchId?: bigint;
  /** v3.2 (R11): with cancellableWei, the first second (Base's clock, unix) the account's cancel works: five minutes
   * after the last deposit to its entry, whoever made it. 0 means no wait (build B: deposits paused, or batches can't
   * be sent). Absent on v3-launch, which has no cooldown. */
  cancelableAt?: number;
  /** v3.2 (R12d, M1): with cancelableAt, the clock it was read on: Base's (`chainTime`, the block's own time) and this
   * device's when the read landed (`readAt`, ms). The receipt counts the wait on Base's clock from them (flows.ts
   * cancelHoldS); without them it holds nothing, and the click's own check decides. */
  cancelClock?: { chainTime: number; readAt: number };
  /** With cancellableWei: a cancel this browser had already sent for it when it was read, which that read found didn't
   * take it out and no longer can (reverted, dropped, or replaced), so the cancel is offered again. A cancel this
   * browser has recorded that isn't this one was sent after the read: the read is behind it (cancel-sent.ts). */
  cancelSeen?: Hex;
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
  /** An estimate until it's paid; absent when unknown. A paid v3 unstake shows what arrived, or nothing. */
  usdcAmount?: number;
  feesUsd?: number;
  /** TAO waiting on Base for the user to claim (or, on v3, to be delivered as USDC). */
  claimable: bigint;
  /** What was actually paid: a claim's receipts, or on v3 the front door's Delivered event. Absent when
   * it can't be read; never estimated. */
  received?: { usdc?: number; keptTao?: number };
  /** v3: today's price is under the unstake's minimum, so its USDC hasn't been sold for it: what its
   * payout would sell for at today's price, in USDC (absent when its share of what waits isn't known). */
  belowMinimum?: { usdcNow?: number };
  /** v3: still on its way back to Base, its USDC to be delivered automatically when it lands. A claim by
   * hand clears the account's delivery preference, so it would then be claimed by hand too. */
  awaitingDelivery?: true;
  /** v3.2: asked as TAO ("Receive TAO"): its payout is claimed on Base by hand, nothing sold for it (unless a later
   * USDC request's delivery sells it: the account's preference decides for all its waiting TAO). */
  keepsTao?: true;
  /** Shares still in the open batch that can be taken back. */
  cancellableShares?: bigint;
  /** With cancellableShares: a cancel this browser had already sent for it that the read found didn't take it out and
   * no longer can (as DepositRecord.cancelSeen). */
  cancelSeen?: Hex;
  /** Nothing was taken when it arrived (balance too small, or the daily limit): unstake again. */
  unstakeAgain?: true;
}
