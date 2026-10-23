/**
 * The data contract between the Cascade UI and wherever the numbers come from.
 *
 * Today everything is served by the mock adapter in `./mock.ts`. A real
 * implementation (contract reads on Base + Bittensor, plus an indexer for the
 * trail receipts) only has to implement `CascadeData`; see `./index.ts`.
 */

export type SourceChain = "base" | "ethereum" | "bnb" | "polygon";

export interface Position {
  /** Staked TAO the account owns right now, rewards included. */
  taoBalance: number;
  /** `taoBalance` at today's TAO price. */
  usdValue: number;
  /** Staking rewards earned so far, in TAO. Kept apart from price moves. */
  rewardsEarnedTao: number;
  taoPriceUsd: number;
  /** TAO from deposits that are still on their way and not staked yet. */
  pendingTao: number;
  /** Average TAO price paid across staked deposits, or null if there are none. */
  avgEntryPriceUsd: number | null;
}

export interface StakeProof {
  allStaked: boolean;
  stakedTao: number;
  owedTao: number;
  checkedAt: Date;
  validatorHotkey: string;
  explorerUrl: string;
}

export type StepStatus = "done" | "active" | "pending";
export type DepositStepKey = "received" | "swapped" | "bridged" | "staked";
export type WithdrawalStepKey = "requested" | "unstaked" | "returned" | "paid";

export interface TrailStep<K extends string = DepositStepKey | WithdrawalStepKey> {
  key: K;
  status: StepStatus;
  title: string;
  detail?: string;
  txUrl?: string;
  /** Link text for `txUrl`. The UI falls back to "View transaction". */
  txLabel?: string;
  at?: Date;
}

export interface DepositRecord {
  id: string;
  createdAt: Date;
  amountUsd: number;
  sourceChain: SourceChain;
  status: "in_progress" | "staked";
  steps: TrailStep<DepositStepKey>[];
  /** TAO staked by this deposit (expected amount while in progress). */
  taoAmount: number;
  feesUsd: number;
  /** TAO price the USDC was swapped at. */
  taoPriceUsd: number;
  /** Rewards this deposit has earned so far. */
  rewardsTao: number;
}

export interface WithdrawalRecord {
  id: string;
  createdAt: Date;
  taoAmount: number;
  status: "in_progress" | "paid";
  steps: TrailStep<WithdrawalStepKey>[];
  /** USDC paid out on Base (an estimate until it's paid). */
  usdcAmount: number;
  feesUsd: number;
}

export interface DepositQuote {
  amountUsd: number;
  chain: SourceChain;
  estTao: number;
  feesUsd: number;
  etaMinutes: number;
  taoPriceUsd: number;
}

export interface WithdrawalQuote {
  taoAmount: number;
  usdcAmount: number;
  feesUsd: number;
  taoPriceUsd: number;
}

export interface DepositLimits {
  minUsd: number;
  maxUsd: number;
}

export interface CascadeData {
  limits: DepositLimits;
  getPosition(account: string): Promise<Position>;
  getProof(account: string): Promise<StakeProof>;
  listDeposits(account: string): Promise<DepositRecord[]>;
  getDeposit(account: string, id: string): Promise<DepositRecord | null>;
  quoteDeposit(amountUsd: number, chain: SourceChain): Promise<DepositQuote>;
  startDeposit(account: string, amountUsd: number, chain: SourceChain): Promise<DepositRecord>;
  quoteWithdrawal(taoAmount: number): Promise<WithdrawalQuote>;
  startWithdrawal(account: string, taoAmount: number): Promise<WithdrawalRecord>;
  listWithdrawals(account: string): Promise<WithdrawalRecord[]>;
  getWithdrawal(account: string, id: string): Promise<WithdrawalRecord | null>;
}
