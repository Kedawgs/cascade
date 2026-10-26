/**
 * The data contract between the Cascade UI and the chains.
 *
 * Every value comes from Base or Bittensor (see ./live.ts) or is derived from chain data by stated
 * arithmetic; anything the chain cannot give is left undefined and hidden. Amounts that feed a
 * transaction are exact `bigint`s (TAO wei, csTAO share units, USDC units, ETH wei); the numbers
 * beside them are for display only. Writes are wallet flows (./flows.ts), not part of this contract.
 */

import type { Clients } from "./chain";
import type { Deployment } from "./config";
import type { OpLog } from "./oplog";
import type { DepositRecord, WithdrawalRecord } from "./records";

export type { DepositRecord, DepositStepKey, StepStatus, TrailStep, WithdrawalRecord, WithdrawalStepKey } from "./records";

export type SourceChain = "base" | "ethereum" | "arbitrum" | "polygon" | "bnb";

export interface Position {
  /** csTAO the account holds on Bittensor, and the part not already asked back. */
  shares: bigint;
  availableShares: bigint;
  /** What those shares are worth in TAO now. */
  taoWei: bigint;
  availableTaoWei: bigint;
  taoBalance: number;
  usdValue: number;
  taoPriceUsd: number;
  /** TAO from deposits still on their way (open batch or on the bridge). */
  pendingTao: number;
  /** Value now + TAO taken out − TAO put in; undefined until there is a deposit. */
  rewardsEarnedTao?: number;
  /** Average price paid across this browser's deposits, or null. */
  avgEntryPriceUsd: number | null;
}

export interface StakeProof {
  /** Everything that can be staked is staked (idle TAO is below what a stake needs). */
  allStaked: boolean;
  stakedTao: number;
  owedTao: number;
  /** The vault holds TAO waiting until one position reaches the chain's 0.02-TAO minimum. */
  waitingForMinimum: boolean;
  /** Bittensor's minimum stake for one position. */
  minimumTao: number;
  checkedAt: Date;
  validatorHotkey: string;
  explorerUrl: string;
}

/** Protocol-wide figures. Missing values are hidden. */
export interface ProtocolStats {
  aprPercent?: number;
  totalStakedTao?: number;
  stakers?: number;
  taoPriceUsd?: number;
}

export interface RewardRecord {
  date: Date;
  taoAccrued: number;
  runningTotalTao: number;
}

export interface DepositQuote {
  usdcIn: bigint;
  /** TAO the swap would give now, and the exact (whole-rao) TAO the deposit asks for. */
  expectedTao: bigint;
  targetTao: bigint;
  estTao: number;
  amountUsd: number;
  taoPriceUsd: number;
  /** Uniswap pool fees on this route; Base gas is extra (cents). */
  feesUsd: number;
  closesAt: Date;
  etaMinutes: number;
  /** The least TAO the swap may return (whole rao, rounded up); v2 has no such floor, so it equals targetTao. */
  minTaoOut: bigint;
  /** Cascade's flat and percentage fees in USDC units (zero on v2), and both in dollars. */
  depositFeeUsdc: bigint;
  swapFeeUsdc: bigint;
  cascadeFeesUsd: number;
}

export interface WithdrawalQuote {
  shares: bigint;
  taoWei: bigint;
  taoAmount: number;
  usdcAmount: number;
  /** ETH to send with `requestRedeem` (the request fee, only for the first request in a batch). */
  fee: bigint;
  /** The bridge fee taken from the payout, in TAO wei. */
  bridgeFeeWei: bigint;
  feesUsd: number;
  taoPriceUsd: number;
  closesAt: Date;
  etaMinutes: number;
  /** v3 delivery: the least USDC (units) per whole TAO the sale may pay, and its unix-second deadline. Zero on v2. */
  minUsdcPerTao: bigint;
  deliveryDeadline: number;
}

export interface Limits {
  minTao: bigint;
  maxTao: bigint;
  minUsd: number;
  maxUsd: number;
}

export interface Balances {
  usdc: bigint;
  tao: bigint;
  eth: bigint;
  usdcRouterAllowance: bigint;
  /** v3: USDC the staker may already take (zero on v2, which has no staker). */
  usdcStakerAllowance: bigint;
  taoRouterAllowance: bigint;
  taoFrontDoorAllowance: bigint;
  /** TAO waiting to be claimed on Base (an unstake's payout, or a deposit the vault sent back). */
  claimable: bigint;
}

export interface CascadeData {
  readonly deployment: Deployment;
  readonly clients: Clients;
  readonly opLog: OpLog;
  getProtocolStats(): Promise<ProtocolStats>;
  getPosition(account: string): Promise<Position>;
  getProof(): Promise<StakeProof>;
  getLimits(): Promise<Limits>;
  getBalances(account: string): Promise<Balances>;
  listRewards(account: string): Promise<RewardRecord[]>;
  listDeposits(account: string): Promise<DepositRecord[]>;
  getDeposit(account: string, id: string): Promise<DepositRecord | null>;
  listWithdrawals(account: string): Promise<WithdrawalRecord[]>;
  getWithdrawal(account: string, id: string): Promise<WithdrawalRecord | null>;
  quoteDeposit(usdcUnits: bigint): Promise<DepositQuote>;
  quoteWithdrawal(account: string, shares: bigint): Promise<WithdrawalQuote>;
}
