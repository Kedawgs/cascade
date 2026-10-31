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

/** The account's stake, from contract reads alone: it never waits on the vault's history. */
export interface Position {
  /** csTAO the account holds on Bittensor. */
  shares: bigint;
  /** What those shares are worth in TAO now. */
  taoWei: bigint;
  taoBalance: number;
  usdValue: number;
  taoPriceUsd: number;
  /** Rewards earned but not yet collected, this account's share after Cascade's cut; undefined when unknown. */
  pendingRewardsTao?: number;
}

/** What can be unstaked: the shares not already asked back (in the open batch, or on their way to the
 * vault), and their TAO now. Waits on the vault's history only while one of this browser's unstakes is
 * on its way and the scan hasn't seen it arrive. */
export interface Available {
  availableShares: bigint;
  availableTaoWei: bigint;
  /** v3: the most TAO one more unstake request can carry (units.unstakeMostWei). Absent on v2. */
  mostTaoWei?: bigint;
}

/** Figures that need the vault's history (its logs since deployment, scanned from where this browser
 * last stopped): "–" until it has been read. */
export interface PositionHistory {
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

/** Protocol-wide figures. A missing value shows as "–". (No count of stakers: there is no indexer.) */
export interface ProtocolStats {
  totalStakedTao?: number;
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
  /** The front door's batch interval, in seconds: how often a batch can leave. */
  batchIntervalS?: number;
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
  /** The front door's batch interval, in seconds: how often a batch can leave. */
  batchIntervalS?: number;
  /** v3 delivery: the least USDC (units) per whole TAO the sale may pay, and its unix-second deadline. Zero on v2. */
  minUsdcPerTao: bigint;
  deliveryDeadline: number;
}

/** v3, for the stake form's break-even line: what leaving costs beyond the percentage fees, and the
 * share of rewards Cascade keeps. */
export interface RoundTripCosts {
  /** The unstake request fee (ETH, at today's ETH price) and the bridge fee back to Base (TAO, at
   * today's TAO price), in dollars. */
  exitFixedUsd: number;
  rewardCutBps: number;
}

export interface Limits {
  minTao: bigint;
  maxTao: bigint;
  minUsd: number;
  maxUsd: number;
  /** Which limit leaves no room for even the smallest deposit: the deposit cap, or the open batch
   * (which frees up once it leaves). */
  full: "cap" | "batch" | null;
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

/** The open batch on Base as the public "Next batch" line needs it, from one multicall (reads.ts,
 * readNextBatch). */
export interface NextBatch {
  id: bigint;
  /** When it started (unix seconds): it can close `interval` seconds later, or sooner once it's full. */
  start: number;
  interval: number;
  canClose: boolean;
  paused: boolean;
  /** How many deposits and unstake requests wait in it. */
  deposits: number;
  redeems: number;
  /** Base's clock when it was read: the timestamp of the block the multicall read (unix seconds). */
  chainTime: number;
}

/** The open batch on Base as "Send it now" needs it (reads.ts, readOpenBatch). Anyone may send a batch once
 * it can close by paying its bridge fee (CascadeFrontDoor.closeBatch): the batch's pot of unstake-request
 * fees pays first, and whatever the fee doesn't take goes back to the sender. */
export interface OpenBatch {
  id: bigint;
  /** When it started (unix seconds): it can close `interval` seconds later, or sooner once it's full. */
  start: number;
  interval: number;
  canClose: boolean;
  paused: boolean;
  /** Base's clock when it was read: the timestamp of the block the multicall read (unix seconds). */
  chainTime: number;
  /** The account's own entries in it: the TAO it deposits and the shares it asks back. */
  mine: { depositWei: bigint; redeemShares: bigint };
  /** The unstake-request fees it holds, which pay its bridge fee first. */
  potWei: bigint;
  /** Read only once it can close (with entries, and not paused); each is undefined when its read failed.
   * The bridge fee to send it now, as the bridge quotes it for this batch's exact message. */
  feeWei?: bigint;
  /** The account's ETH on Base, and an allowance for closeBatch's network fee. */
  ethWei?: bigint;
  gasWei?: bigint;
  ethPriceUsd?: number;
  /** Read while the keeper may still send it for free at its interval (until five minutes after it, and
   * not full): the keeper's own weighing of its fees against its bridge fee (send-now.ts,
   * closeEconomicsOf). null when any of it can't be read: the keeper then holds the batch too. */
  economics?: CloseEconomics | null;
  /** Read once it can close: whether Bittensor's side can take a batch (the vault not paused, ForeverMoney's
   * AlphaVault not paused, with no migration announced or finished). false when that can't be read. */
  bittensorOpen?: boolean;
}

/** What closing the open batch earns and costs, as the keeper weighs it, in USDC units (6 decimals):
 * Cascade's fees in the batch (the staker's deposit and swap fees on the deposits it made, and the pot)
 * and the bridge fee. The keeper sends a batch at its interval once the first covers the second. */
export interface CloseEconomics {
  feesUsdc: bigint;
  bridgeFeeUsdc: bigint;
}

export interface CascadeData {
  readonly deployment: Deployment;
  readonly clients: Clients;
  readonly opLog: OpLog;
  getProtocolStats(): Promise<ProtocolStats>;
  /** The yield in TAO of root staking with the vault's validator over the last 30 days, after its take
   * and Cascade's cut, as a percent. Rejects when there is no figure that can be stood behind. */
  getApy(): Promise<number>;
  getPosition(account: string): Promise<Position>;
  getAvailable(account: string): Promise<Available>;
  getPositionHistory(account: string): Promise<PositionHistory>;
  getProof(): Promise<StakeProof>;
  getLimits(): Promise<Limits>;
  getBalances(account: string): Promise<Balances>;
  listRewards(account: string): Promise<RewardRecord[]>;
  /** Every deposit of the account (a receipt picks its own from this list: hooks.ts, useDeposit). */
  listDeposits(account: string): Promise<DepositRecord[]>;
  /** Every unstake of the account (a receipt picks its own from this list: hooks.ts, useWithdrawal). */
  listWithdrawals(account: string): Promise<WithdrawalRecord[]>;
  quoteDeposit(usdcUnits: bigint): Promise<DepositQuote>;
  quoteWithdrawal(account: string, shares: bigint): Promise<WithdrawalQuote>;
  /** The costs of a later unstake of `taoWei`, and Cascade's reward cut. */
  quoteRoundTrip(taoWei: bigint): Promise<RoundTripCosts>;
  /** The open batch, the account's part in it, and once it can close what sending it now costs. */
  getOpenBatch(account: string): Promise<OpenBatch>;
  /** The open batch for anyone: when it started, what waits in it, and Base's clock (one multicall). */
  getNextBatch(): Promise<NextBatch>;
  /** Whether the contracts are wired to each other as the build's config says (wiring.ts); an answer is
   * kept 15 minutes. Rejects when they can't be read right now: nothing may be sent until it resolves "ok". */
  checkWiring(): Promise<"ok" | "mismatch">;
  /** Drops the kept answer, so the next checkWiring reads the chain again (after each flow). */
  forgetWiring(): void;
}
